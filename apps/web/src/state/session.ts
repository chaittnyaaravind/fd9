import { create } from "zustand";
import type { OfferedFile } from "@fd9/protocol";
import {
  deriveConnectionStage,
  describeConnectionFailure,
  negotiatedMaxChunkSize,
  openNegotiatedChannels,
  toRTCIceServers,
  watchConnectionDiagnostics,
  wireSignalingForPeerConnection,
  type ConnectionDiagnostics,
  type ConnectionStage,
  type LinkQuality
} from "../lib/rtc.js";
import { SignalingClient, type SignalingState } from "../lib/signalingClient.js";
import { SyntheticChunkSource } from "../lib/transfer/benchmarkSource.js";
import { createDiscardSink, type FileSink } from "../lib/transfer/sinks.js";
import { listenForAnswererPeerLanes, openOffererPeerLaneWithRetry, type PeerLaneHandle } from "../lib/transfer/peerLane.js";
import { ReceiverEngine, type IncomingOffer } from "../lib/transfer/receiver.js";
import { SenderEngine } from "../lib/transfer/sender.js";
import type { FileProgress, SendableFile } from "../lib/transfer/types.js";
import { WakeLockController } from "../lib/wakeLock.js";

export type ConnectionPhase =
  | "idle"
  | "waiting-for-peer"
  | "connecting"
  | "connected"
  | "transferring"
  | "completed"
  | "failed"
  | "closed"
  /** Signaling dropped (e.g. phone switched Wi-Fi<->cellular) or ICE is stuck; attempting to recover. */
  | "reconnecting";

export type Role = "sender" | "receiver";

export interface ReadyFile {
  fileIndex: number;
  name: string;
  blob: Blob | null;
}

interface Fd9State {
  role: Role | null;
  phase: ConnectionPhase;
  linkQuality: LinkQuality;
  roomCode: string | null;
  roomLink: string | null;
  errorMessage: string | null;
  incomingOffer: IncomingOffer | null;
  files: FileProgress[];
  readyFiles: ReadyFile[];
  wakeLockActive: boolean;
  /** True when this session was started with `?forceRelay=1` (the decisive TURN test). */
  forcedRelay: boolean;
  diagnostics: ConnectionDiagnostics;
  /** Derived from `diagnostics` (see rtc.ts's deriveConnectionStage) — meaningful only while phase === "connecting"; stage-aware UI copy reads this, never fabricates its own narration. */
  connectionStage: ConnectionStage;
  signalingState: SignalingState | "idle";
  controlChannelState: RTCDataChannelState | "none";
  dataChannelState: RTCDataChannelState | "none";
  /** Live data-channel send-buffer depth, in bytes — the backpressure signal itself, not inferred. */
  bufferedAmount: number;
  /** On-screen connection timeline (candidate-pair changes, reconnects) — visible in the UI, not just devtools, since a phone test has no console open. */
  connectionTimeline: { t: number; label: string }[];
  /** The real, negotiated per-connection chunk size once known (see negotiatedMaxChunkSize). */
  chunkSize: number | null;
  /** Derived purely from confirmedBytes deltas over wall-clock time — not a transport-layer measurement, just observing the existing progress stream. Recent-window average. */
  sustainedMBs: number;
  /** Highest sustainedMBs sample seen this session. */
  peakMBs: number;

  startSending: (files: File[]) => Promise<void>;
  /** Benchmark mode (Phase 0 of the throughput audit) — sends `sizeBytes` of synthetic data instead of a real file. See SyntheticChunkSource. */
  startSendingBenchmark: (sizeBytes: number) => Promise<void>;
  startReceiving: (joinBy: { code?: string; roomId?: string }) => Promise<void>;
  acceptIncoming: (acceptedIndices: number[], rejectedIndices: number[], sinks: Map<number, FileSink>) => void;
  /** Benchmark mode "Benchmark A" — see acceptIncomingBenchmarkDiscard's implementation. */
  acceptIncomingBenchmarkDiscard: () => void;
  pauseFile: (fileIndex: number) => void;
  resumeFile: (fileIndex: number) => void;
  cancelFile: (fileIndex: number) => void;
  reset: () => void;
}

function resolveSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:8787`;
}

/**
 * Decisive TURN test switch (spec section 5): `?forceRelay=1` in the URL
 * forces `iceTransportPolicy: "relay"`, so ICE can only use TURN candidates.
 * If a real file transfer still completes with this on, relay genuinely
 * works — candidates merely appearing in getStats() is not proof enough.
 */
function resolveForceRelay(): boolean {
  return new URLSearchParams(window.location.search).get("forceRelay") === "1";
}

/** Once in one of these, a session is over — no later signaling event may move it back to an "active" phase. */
const TERMINAL_PHASES = new Set<ConnectionPhase>(["completed", "failed", "closed"]);

/**
 * Bounds the INITIAL connection attempt only (not a live transfer already in
 * progress — that's governed by restartIce()/attemptReconnect()'s own much
 * longer backoff window). Some networks (confirmed directly: a campus guest
 * Wi-Fi that blocks WebRTC UDP outright, for both direct AND relay
 * candidates) never produce a usable candidate pair at all — `channels.ready`
 * then waits forever with nothing to show the user. 30s matches the
 * established timeout used for the equivalent gap in the diagnostic
 * benchmark tool (pc-scaling-bench.js), where this exact failure mode was
 * first observed and fixed.
 */
const CONNECTION_ESTABLISH_TIMEOUT_MS = 30000;

/**
 * Sentinel only — carries no diagnostics-derived message itself. The catch
 * site (setupPeerConnection) computes the actual user-facing text from the
 * LATEST real diagnostics via rtc.ts's describeConnectionFailure(), so the
 * message is always evidence-graded, never a blind assertion baked in here
 * before we know what ICE actually observed.
 */
class ConnectionBlockedError extends Error {
  constructor() {
    super("Connection establishment timed out.");
    this.name = "ConnectionBlockedError";
  }
}

function waitWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new ConnectionBlockedError()), ms))
  ]);
}

/** Bounds the signaling WebSocket's own opening handshake (e.g. a CORS/origin rejection, or the server being unreachable) — distinct from CONNECTION_ESTABLISH_TIMEOUT_MS, which only covers ICE/peer connection after signaling is already open. */
const SIGNALING_CONNECT_TIMEOUT_MS = 15000;

class SignalingUnavailableError extends Error {
  constructor() {
    super("Could not reach the signaling server.");
    this.name = "SignalingUnavailableError";
  }
}

/**
 * Resolves once `client` reaches "open"; rejects on "closed" (e.g. the
 * server rejected the Origin, or the handshake otherwise failed) or on
 * timeout. Without this, a rejected handshake left the caller awaiting a
 * promise that only ever listened for "open" — "closed" was silently
 * ignored, so the UI hung on "Creating a session…"/"Waiting for the other
 * device…" forever with no error and no way to retry.
 */
function waitForSignalingOpen(client: SignalingClient, ms = SIGNALING_CONNECT_TIMEOUT_MS): Promise<void> {
  if (client.state === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new SignalingUnavailableError());
    }, ms);
    const unsub = client.onStateChange((state) => {
      if (state === "open") {
        clearTimeout(timer);
        unsub();
        resolve();
      } else if (state === "closed") {
        clearTimeout(timer);
        unsub();
        reject(new SignalingUnavailableError());
      }
    });
  });
}

const DEFAULT_DIAGNOSTICS: ConnectionDiagnostics = {
  quality: "unknown",
  turnTransports: { udp: "unknown", tcp: "unknown", tls: "unknown" },
  iceCandidateErrors: [],
  iceConnectionState: "new",
  connectionState: "new",
  localCandidateType: null,
  remoteCandidateType: null,
  hasSelectedPair: false,
  rttMs: null,
  localProtocol: null,
  remoteProtocol: null,
  selectedRelayProtocol: null,
  localCandidateCounts: { host: 0, srflx: 0, relay: 0, prflx: 0 }
};

// Non-reactive session internals — reset() tears these all down.
let signaling: SignalingClient | null = null;
let pc: RTCPeerConnection | null = null;
let senderEngine: SenderEngine | null = null;
let receiverEngine: ReceiverEngine | null = null;
// Throughput sampling (diagnostics only) — tracks confirmedBytes deltas over
// wall-clock time from the EXISTING progress stream. Never reads anything
// transport-layer doesn't already expose; purely an observer.
let lastThroughputSampleAt = 0;
let lastThroughputBytes = 0;
// Cached per-session so the TURN-credential round trip can be KICKED OFF the
// moment signaling opens (overlapping it with "waiting for peer" time, which
// in practice dwarfs the credential fetch) instead of only starting once
// setupPeerConnection() is reached. Idempotent — a second call while one is
// already in flight (or already resolved) returns the SAME promise, never a
// duplicate `request-turn-credentials` send. Reset to null in teardown() so
// a new session never reuses a prior session's (possibly stale, possibly
// never-resolved) request.
let iceServersRequest: Promise<RTCIceServer[]> | null = null;
let wakeLock: WakeLockController | null = null;
let stopLinkWatch: (() => void) | null = null;
let stopChannelWatch: (() => void) | null = null;
// Captured once when the PRIMARY connection negotiates, reused unchanged by
// every independent secondary lane (see peerLane.ts) so they reach for the
// same TURN/STUN servers and the same forced-relay-or-not policy.
let cachedIceServers: RTCIceServer[] = [];
let cachedIceTransportPolicy: RTCIceTransportPolicy = "all";
// Secondary bulk-transfer lanes — each its own independent RTCPeerConnection
// (see peerLane.ts), tracked here only so teardown()/reset() can close them
// all, not just the primary `pc`.
const secondaryLanes = new Map<string, PeerLaneHandle>();
let stopAnswererLaneListener: (() => void) | null = null;

// Survive a dropped signaling WebSocket (e.g. a phone's Wi-Fi<->cellular
// handoff tears down its TCP connection) so a fresh socket can resume the
// same room as the same logical peer, then re-trigger ICE renegotiation.
let savedRoomId: string | null = null;
let savedPeerId: string | null = null;
let savedIsInitiator = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttemptNumber = 0;
let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
let stopNetworkWatch: (() => void) | null = null;
/** Set right before we close signaling ourselves, so that close doesn't get mistaken for a drop. */
let intentionalClose = false;

/**
 * ICE restart (spec section 15): only the session's original initiator ever
 * generates a restart offer, so both sides independently detecting the same
 * broken candidate pair doesn't race into SDP glare. The responder's
 * already-attached wireSignalingForPeerConnection handles the incoming offer
 * the normal way — ICE restart reuses the existing offer/answer relay, no protocol
 * change needed. Negotiated (not renegotiated) data channels survive this
 * unchanged; only transport-level connectivity is renegotiated.
 */
async function restartIce(): Promise<void> {
  console.debug("[fd9] restartIce()", { pc: !!pc, signalingState: signaling?.state });
  if (!pc || !signaling || signaling.state !== "open") return;
  // Any ICE restart might have silently dropped already-"sent" bytes if the
  // browser rebuilt the SCTP association underneath — see SenderEngine.handleReconnect.
  senderEngine?.handleReconnect();
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    signaling.send({ type: "relay-sdp", payload: { type: "offer", sdp: offer.sdp ?? "" } });
    console.debug("[fd9] restartIce() sent new offer");
  } catch (err) {
    console.debug("[fd9] restartIce() failed", err);
  }
}

function teardown(): void {
  stopLinkWatch?.();
  stopLinkWatch = null;
  stopChannelWatch?.();
  stopChannelWatch = null;
  stopNetworkWatch?.();
  stopNetworkWatch = null;
  stopAnswererLaneListener?.();
  stopAnswererLaneListener = null;
  for (const handle of secondaryLanes.values()) handle.close();
  secondaryLanes.clear();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttemptNumber = 0;
  if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
  disconnectGraceTimer = null;
  savedRoomId = null;
  savedPeerId = null;
  savedIsInitiator = false;
  pc?.close();
  pc = null;
  intentionalClose = true;
  signaling?.close();
  signaling = null;
  senderEngine = null;
  receiverEngine = null;
  void wakeLock?.release();
  wakeLock = null;
  lastThroughputSampleAt = 0;
  lastThroughputBytes = 0;
  iceServersRequest = null;
}

export const useSessionStore = create<Fd9State>((set, get) => {
  /** Appends to the on-screen connection timeline — visible in the UI itself, since a phone test has no console open. Bounded to the last 30 entries. */
  function pushTimeline(label: string): void {
    set((state) => ({ connectionTimeline: [...state.connectionTimeline.slice(-29), { t: Date.now(), label }] }));
  }

  /**
   * Fire-and-cache: starts (or reuses) the `request-turn-credentials` round
   * trip. Called EARLY (right after signaling opens, well before a peer has
   * even joined) so the wait overlaps with "waiting for peer" time instead
   * of serially delaying setupPeerConnection() once a peer finally shows up
   * — in the common case this makes the later `await` resolve immediately.
   * Idempotent: a second call (e.g. setupPeerConnection() itself also wants
   * this) while one is in flight or already resolved returns the SAME
   * promise — never a duplicate send. Direct-only filtering is baked into
   * the cached result since `noTurn` is a static, session-constant URL param.
   */
  function requestIceServers(directOnly: boolean): Promise<RTCIceServer[]> {
    if (iceServersRequest) return iceServersRequest;
    iceServersRequest = new Promise<RTCIceServer[]>((resolve) => {
      const unsub = signaling!.onMessage((msg) => {
        if (msg.type === "turn-credentials") {
          unsub();
          resolve(toRTCIceServers(msg.servers));
        }
      });
      signaling!.send({ type: "request-turn-credentials" });
    }).then((allIceServers) =>
      // Direct-only diagnostic mode (spec Phase 4): strip every TURN/TURNS
      // URL before it ever reaches RTCPeerConnection, so relay candidates
      // literally cannot exist — if direct/STUN genuinely can't connect,
      // ICE fails visibly instead of silently succeeding via relay. STUN
      // entries are kept (they only ever yield host/srflx candidates, never relay).
      directOnly
        ? allIceServers
            .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u.startsWith("stun:")) }))
            .filter((s) => s.urls.length > 0)
        : allIceServers
    );
    return iceServersRequest;
  }

  async function setupPeerConnection(isInitiator: boolean): Promise<{ control: ReturnType<typeof openNegotiatedChannels>["control"]; lanes: ReturnType<typeof openNegotiatedChannels>["lanes"] }> {
    set({ phase: "connecting" });

    const directOnly = new URLSearchParams(window.location.search).get("noTurn") === "1";
    const iceServers = await requestIceServers(directOnly);
    pushTimeline(directOnly ? "DIRECT-ONLY TEST: TURN servers stripped from ICE config" : "ICE servers received");

    const forcedRelay = resolveForceRelay();
    set({ forcedRelay });
    const iceTransportPolicy: RTCIceTransportPolicy = forcedRelay ? "relay" : "all";
    cachedIceServers = iceServers;
    cachedIceTransportPolicy = iceTransportPolicy;
    pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    // Lane 0 only — the primary connection's own data channel, which is the
    // N=1 fallback. Any additional lane is a genuinely independent
    // RTCPeerConnection (see peerLane.ts), never a sibling channel here.
    const channels = openNegotiatedChannels(pc, 1);

    stopChannelWatch?.();
    const watchInterval = setInterval(() => {
      set({
        controlChannelState: channels.control.readyState ?? "none",
        // UI shows lane 0's state as representative, and total buffered
        // bytes across every lane as the aggregate backpressure signal.
        dataChannelState: channels.lanes[0]?.readyState ?? "none",
        bufferedAmount: channels.lanes.reduce((sum, l) => sum + l.bufferedAmount, 0)
      });
    }, 500);
    stopChannelWatch = () => clearInterval(watchInterval);

    pc.onconnectionstatechange = () => {
      const cstate = pc?.connectionState;
      if (cstate === "connected") {
        if (disconnectGraceTimer) {
          clearTimeout(disconnectGraceTimer);
          disconnectGraceTimer = null;
        }
        return;
      }
      console.debug("[fd9] pc.connectionState ->", cstate);
      if (cstate === "closed") return; // only from our own teardown
      if (cstate === "failed") {
        if (disconnectGraceTimer) {
          clearTimeout(disconnectGraceTimer);
          disconnectGraceTimer = null;
        }
        if (savedIsInitiator && signaling?.state === "open") {
          void restartIce();
        } else {
          set({ phase: "reconnecting", errorMessage: "Connection trouble — attempting to recover…" });
        }
        return;
      }
      if (cstate === "disconnected" && !disconnectGraceTimer) {
        // "disconnected" is explicitly the ICE spec's TRANSIENT state, not a
        // terminal one — WebRTC itself is already trying to recover the
        // existing (possibly still-direct) path. Firing an ICE restart too
        // eagerly risks a renegotiation landing on a different, possibly
        // worse (relay) candidate pair even when the original direct path
        // would have recovered on its own given more time. 15s, not 5s.
        disconnectGraceTimer = setTimeout(() => {
          disconnectGraceTimer = null;
          if (pc?.connectionState === "disconnected" && savedIsInitiator && signaling?.state === "open") {
            void restartIce();
          }
        }, 15000);
      }
    };

    let lastCandidateType = get().diagnostics.localCandidateType;
    stopLinkWatch = watchConnectionDiagnostics(pc, (diagnostics) => {
      if (diagnostics.hasSelectedPair && diagnostics.localCandidateType !== lastCandidateType) {
        const bytesAtTransition = get().files.reduce((sum, f) => sum + f.confirmedBytes, 0);
        const mb = (bytesAtTransition / (1024 * 1024)).toFixed(1);
        pushTimeline(
          `candidate pair: ${lastCandidateType ?? "(none)"} → ${diagnostics.localCandidateType} (RTT ${diagnostics.rttMs ?? "?"}ms, at ${mb} MB transferred)`
        );
        lastCandidateType = diagnostics.localCandidateType;
      }
      set({ diagnostics, linkQuality: diagnostics.quality, connectionStage: deriveConnectionStage(diagnostics) });
    });

    wireSignalingForPeerConnection(signaling!, pc);

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signaling!.send({ type: "relay-sdp", payload: { type: "offer", sdp: offer.sdp ?? "" } });
    }

    try {
      await waitWithTimeout(channels.ready, CONNECTION_ESTABLISH_TIMEOUT_MS);
    } catch (err) {
      pc?.close();
      pc = null;
      if (err instanceof ConnectionBlockedError) {
        // Compute the user-facing message NOW, from whatever diagnostics
        // were actually observed before giving up — never the blind,
        // evidence-free assertion this used to carry by default.
        throw new Error(describeConnectionFailure(get().diagnostics));
      }
      throw err;
    }
    set({ phase: "connected" });
    wakeLock = new WakeLockController();
    wakeLock.onLoss(() => set({ wakeLockActive: false }));
    void wakeLock.acquire().then((ok) => set({ wakeLockActive: ok }));

    return channels;
  }

  /**
   * Samples sustained throughput from the SAME `files` array the progress
   * handlers already receive — confirmedBytes is the authoritative
   * "verified moved" counter on both sender and receiver (see FileProgress).
   * Diagnostics-only: never reads anything beyond what's already public on
   * FileProgress, never touches TransportPool/sender/receiver internals.
   */
  function recordThroughputSample(files: FileProgress[]): void {
    const totalConfirmed = files.reduce((sum, f) => sum + f.confirmedBytes, 0);
    const now = performance.now();
    if (lastThroughputSampleAt === 0) {
      lastThroughputSampleAt = now;
      lastThroughputBytes = totalConfirmed;
      return;
    }
    const elapsedSec = (now - lastThroughputSampleAt) / 1000;
    if (elapsedSec < 0.2) return; // same throttle cadence as the sender's own emitProgressThrottled
    const deltaBytes = totalConfirmed - lastThroughputBytes;
    lastThroughputSampleAt = now;
    lastThroughputBytes = totalConfirmed;
    if (deltaBytes < 0) return; // a reseek/reconnect can rewind confirmedBytes briefly — not a real throughput sample
    const mbs = deltaBytes / (1024 * 1024) / elapsedSec;
    set((state) => ({ sustainedMBs: mbs, peakMBs: Math.max(state.peakMBs, mbs) }));
  }

  /**
   * "session-complete" only means the sender finished attempting every file —
   * it says nothing about whether each one actually verified. Only declare
   * the user-facing "completed" phase when every file's own status says so;
   * otherwise this is a real failure, not a success (spec section 23: never
   * claim "Transfer complete" without the receiver's own integrity verdict).
   */
  function finishSession(): void {
    const files = get().files;
    console.debug("[fd9] finishSession", files.map((f) => ({ fileIndex: f.fileIndex, status: f.status })));
    const allOk = files.length > 0 && files.every((f) => f.status === "completed" || f.status === "rejected" || f.status === "cancelled");
    if (allOk) {
      set({ phase: "completed" });
    } else {
      const failed = files.filter((f) => f.status === "failed");
      const reason = failed.length === 1 ? failed[0].error ?? "Transfer failed." : failed.length > 1 ? `${failed.length} files failed.` : "The transfer did not complete successfully.";
      set({ phase: "failed", errorMessage: reason });
    }
  }

  function bindSenderEngine(engine: SenderEngine): void {
    engine.on("progress", (files) => {
      set({ files, phase: files.some((f) => f.status === "transferring") ? "transferring" : get().phase });
      recordThroughputSample(files);
    });
    engine.on("session-complete", finishSession);
    // Debug surface for the Phase-0 throughput audit's per-stage timing —
    // inspectable live via `window.__fd9SenderPipelineStats` on the actual
    // device, so a real-browser bottleneck investigation isn't limited to
    // Node-level benchmarks.
    engine.on("pipeline-stats", (s) => {
      if (typeof window === "undefined") return;
      (window as unknown as { __fd9SenderPipelineStats?: unknown }).__fd9SenderPipelineStats = s;
    });
  }

  /**
   * Shared body of startSending/startSendingBenchmark — everything that
   * doesn't care whether `sendableFiles` came from a real file picker or a
   * SyntheticChunkSource. Keeping this as one path (not two parallel
   * implementations) is what makes benchmark mode trustworthy: it goes
   * through the exact same SenderEngine, signaling, and connection setup a
   * real transfer does.
   */
  async function startSendingCore(sendableFiles: SendableFile[]): Promise<void> {
    teardown();
    set({
      role: "sender",
      phase: "waiting-for-peer",
      errorMessage: null,
      files: [],
      readyFiles: [],
      incomingOffer: null,
      diagnostics: DEFAULT_DIAGNOSTICS,
      connectionStage: "preparing",
      controlChannelState: "none",
      dataChannelState: "none",
      bufferedAmount: 0,
      chunkSize: null,
      sustainedMBs: 0,
      peakMBs: 0,
      connectionTimeline: []
    });

    signaling = new SignalingClient(resolveSignalingUrl());
    watchSignalingState(signaling);
    stopNetworkWatch?.();
    stopNetworkWatch = startNetworkWatch();
    try {
      await waitForSignalingOpen(signaling);
    } catch {
      if (!TERMINAL_PHASES.has(get().phase)) {
        set({ phase: "failed", errorMessage: "Could not reach the signaling server. Check your connection and try again." });
      }
      return;
    }

    signaling.send({ type: "create-room" });
    bindLifecycleSignaling(signaling);
    savedIsInitiator = true;
    // Kicked off now, not awaited — overlaps the TURN-credential round trip
    // with "waiting for peer" time (see requestIceServers's doc comment).
    void requestIceServers(new URLSearchParams(window.location.search).get("noTurn") === "1");

    signaling.onMessage((msg) => {
      if (msg.type === "room-created") {
        savedRoomId = msg.roomId;
        savedPeerId = msg.peerId;
        const link = `${window.location.origin}${window.location.pathname}?room=${msg.roomId}`;
        set({ roomCode: msg.code, roomLink: link });
      } else if (msg.type === "peer-joined") {
        void setupPeerConnection(true).then(({ control, lanes }) => {
          const params = new URLSearchParams(window.location.search);
          const windowOverrideMiB = Number(params.get("sendWindowMiB"));
          const chunkOverrideKiB = Number(params.get("chunkKiB"));
          const negotiated = pc ? negotiatedMaxChunkSize(pc) : undefined;
          const chunkSize = chunkOverrideKiB > 0 ? chunkOverrideKiB * 1024 : negotiated;
          set({ chunkSize: chunkSize ?? null });
          const highWatermark = windowOverrideMiB > 0 ? windowOverrideMiB * 1024 * 1024 : undefined;
          const lowWatermark = highWatermark ? Math.floor(highWatermark / 4) : undefined;
          // Always start at N=1 (the primary connection's own lane) —
          // every additional lane is now a genuinely independent
          // RTCPeerConnection, so growth only happens once MEASURED
          // throughput actually justifies the cost of negotiating one,
          // never seeded ahead of evidence.
          const growLane = (connectionId: string) =>
            openOffererPeerLaneWithRetry(signaling!, cachedIceServers, cachedIceTransportPolicy, connectionId)
              .then((handle) => {
                secondaryLanes.set(connectionId, handle);
                handle.onFailed(() => {
                  senderEngine?.handleLaneFailure(handle.dataChannel);
                  secondaryLanes.delete(connectionId);
                });
                return handle.dataChannel;
              })
              .catch(() => null);
          senderEngine = new SenderEngine(control, lanes, sendableFiles, chunkSize, highWatermark, lowWatermark, 1, growLane);
          bindSenderEngine(senderEngine);
          void senderEngine.offer();
        }).catch((err: unknown) => {
          if (!TERMINAL_PHASES.has(get().phase)) {
            set({ phase: "failed", errorMessage: err instanceof Error ? err.message : "Failed to establish a connection." });
          }
        });
      } else if (msg.type === "error") {
        set({ phase: "failed", errorMessage: msg.message });
      }
    });
  }

  function bindReceiverEngine(engine: ReceiverEngine): void {
    engine.on("offer", (offer) => set({ incomingOffer: offer }));
    engine.on("progress", (files) => {
      set({ files, phase: files.some((f) => f.status === "transferring") ? "transferring" : get().phase });
      recordThroughputSample(files);
    });
    engine.on("file-ready", (ready) => {
      set((state) => ({ readyFiles: [...state.readyFiles, ready] }));
    });
    engine.on("session-complete", finishSession);
    // Debug surface for the receive-side storage pipeline — inspectable live
    // from devtools (`window.__fd9ReceiveDiagnostics` / `...Log`) on the
    // actual receiving device, exactly the instrumentation needed to see
    // bytesReceived/bytesPersisted/inFlightBytes/backpressure state while a
    // large transfer is in progress. The log is a bounded ring buffer so it
    // can never itself become an unbounded-growth problem.
    engine.on("receive-diagnostics", (d) => {
      if (typeof window === "undefined") return;
      const w = window as unknown as {
        __fd9ReceiveDiagnostics?: unknown;
        __fd9ReceiveDiagnosticsLog?: Array<Record<string, unknown>>;
      };
      w.__fd9ReceiveDiagnostics = d;
      const log = (w.__fd9ReceiveDiagnosticsLog ??= []);
      log.push({ ...d, t: Date.now() });
      if (log.length > 1000) log.shift();
    });
    engine.on("pipeline-stats", (s) => {
      if (typeof window === "undefined") return;
      (window as unknown as { __fd9ReceiverPipelineStats?: unknown }).__fd9ReceiverPipelineStats = s;
    });
  }

  /** Shared lifecycle handlers for the room-level reconnect protocol, re-attached to each new signaling client. */
  function bindLifecycleSignaling(client: SignalingClient): void {
    client.onMessage((msg) => {
      if (msg.type === "peer-left" || msg.type === "peer-disconnected" || msg.type === "peer-reconnected") {
        pushTimeline(`signaling: ${msg.type}`);
      }
      // Once a session has genuinely finished, nothing the signaling layer
      // reports afterward (a late peer-left/disconnected/reconnected from a
      // connection that's since been superseded or torn down) may downgrade
      // it — a completed/failed transfer must stay completed/failed.
      if (TERMINAL_PHASES.has(get().phase)) return;
      if (msg.type === "peer-left") {
        senderEngine?.abortAll("The other device left.");
        receiverEngine?.abortAll("The other device left.");
        set({ phase: "failed", errorMessage: "The other device left." });
      } else if (msg.type === "peer-disconnected") {
        set({ phase: "reconnecting", errorMessage: "Other device lost its connection — waiting for it to come back…" });
      } else if (msg.type === "peer-reconnected") {
        set({ phase: pc?.connectionState === "connected" ? "connected" : "connecting", errorMessage: null });
        if (savedIsInitiator && pc && pc.connectionState !== "connected") {
          void restartIce();
        }
      }
    });
  }

  // Exponential backoff, capped — but patient enough that losing real
  // progress on a multi-GB transfer (which can be most of the way through
  // when a brief network hiccup hits) isn't abandoned after under a minute.
  // Total window here is ~4.5 minutes before genuinely giving up.
  const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 20000, 30000, 30000, 30000, 30000, 30000];

  /** Reopens a signaling WebSocket and resumes the same room as the same peer, then re-triggers ICE if needed. */
  function attemptReconnect(attempt: number): void {
    pushTimeline(`reconnect attempt ${attempt + 1}/${RECONNECT_DELAYS_MS.length}`);
    if (TERMINAL_PHASES.has(get().phase)) return; // session already finished — nothing left to reconnect for
    reconnectAttemptNumber = attempt;
    if (!savedRoomId || !savedPeerId) {
      set({ phase: "failed", errorMessage: "Lost connection and couldn't resume the session." });
      return;
    }
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      pushTimeline("reconnect exhausted — giving up");
      senderEngine?.abortAll("Lost connection to the other device.");
      receiverEngine?.abortAll("Lost connection to the other device.");
      set({ phase: "failed", errorMessage: "Lost connection to the other device and couldn't reconnect." });
      return;
    }

    set({ phase: "reconnecting", errorMessage: "Reconnecting…" });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const roomId = savedRoomId!;
      const peerId = savedPeerId!;
      const client = new SignalingClient(resolveSignalingUrl());
      let settled = false;

      const giveUp = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.close();
        attemptReconnect(attempt + 1);
      }, 6000);

      const unsubState = client.onStateChange((state) => {
        console.debug("[fd9] reconnect attempt", attempt, "client state ->", state);
        if (state === "open" && !settled) {
          client.send({ type: "rejoin-room", roomId, peerId });
        } else if (state === "closed" && !settled) {
          settled = true;
          clearTimeout(giveUp);
          attemptReconnect(attempt + 1);
        }
      });

      const unsubMsg = client.onMessage((msg) => {
        if (settled) return;
        console.debug("[fd9] reconnect attempt", attempt, "msg ->", msg.type);
        if (msg.type === "rejoined") {
          settled = true;
          clearTimeout(giveUp);
          unsubState();
          unsubMsg();
          intentionalClose = false;
          signaling = client;
          watchSignalingState(client);
          bindLifecycleSignaling(client);
          if (pc) wireSignalingForPeerConnection(client, pc);
          if (!TERMINAL_PHASES.has(get().phase)) {
            set({ phase: pc?.connectionState === "connected" ? "connected" : "connecting", errorMessage: null });
            if (savedIsInitiator && pc && pc.connectionState !== "connected") {
              void restartIce();
            }
          }
        } else if (msg.type === "error" && (msg.code === "rejoin-failed" || msg.code === "room-not-found")) {
          settled = true;
          clearTimeout(giveUp);
          unsubState();
          unsubMsg();
          client.close();
          attemptReconnect(attempt + 1);
        }
      });
    }, RECONNECT_DELAYS_MS[attempt]);
  }

  function watchSignalingState(client: SignalingClient): void {
    set({ signalingState: client.state });
    client.onStateChange((state) => {
      console.debug("[fd9] watchSignalingState", state, "intentionalClose", intentionalClose, "isCurrent", client === signaling);
      // A client superseded by a later reconnect can still fire its OWN late
      // "closed" event (e.g. its close() took a long time to resolve while
      // offline) — that must not spuriously re-trigger reconnect logic for
      // the connection that has since replaced it.
      if (client !== signaling) return;
      set({ signalingState: state });
      if (state === "closed" && !intentionalClose) {
        const phase = get().phase;
        if (savedRoomId && savedPeerId && phase !== "idle" && phase !== "closed" && phase !== "completed" && phase !== "failed") {
          attemptReconnect(0);
        }
      }
      intentionalClose = false;
    });
  }

  /**
   * The browser's own `online`/`offline` events fire immediately on a real
   * interface change (phone Wi-Fi<->cellular) — far faster than waiting for
   * the signaling heartbeat or an ICE timeout to notice. `offline` proactively
   * closes the current signaling socket (surfacing the drop right away,
   * instead of a dead-but-not-yet-detected connection); `online` skips any
   * remaining backoff delay and retries the in-progress reconnect immediately.
   */
  function startNetworkWatch(): () => void {
    const onOffline = () => {
      console.debug("[fd9] browser went offline");
      if (signaling && signaling.state !== "closed") signaling.close();
    };
    const onOnline = () => {
      console.debug("[fd9] browser came back online");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attemptReconnect(reconnectAttemptNumber);
      }
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }

  return {
    role: null,
    phase: "idle",
    linkQuality: "unknown",
    roomCode: null,
    roomLink: null,
    errorMessage: null,
    incomingOffer: null,
    files: [],
    readyFiles: [],
    wakeLockActive: false,
    forcedRelay: false,
    diagnostics: DEFAULT_DIAGNOSTICS,
    connectionStage: "preparing",
    signalingState: "idle",
    controlChannelState: "none",
    dataChannelState: "none",
    bufferedAmount: 0,
    chunkSize: null,
    sustainedMBs: 0,
    peakMBs: 0,
    connectionTimeline: [],

    async startSending(inputFiles: File[]) {
      const sendableFiles: SendableFile[] = inputFiles.map((f, i) => ({
        fileIndex: i,
        name: f.name,
        size: f.size,
        mimeType: f.type || "application/octet-stream",
        source: f
      }));
      await startSendingCore(sendableFiles);
    },

    async startSendingBenchmark(sizeBytes: number) {
      // Benchmark mode (Phase 0 of the throughput audit): a SyntheticChunkSource
      // generates bytes on demand instead of reading a real file, isolating
      // the data-plane pipeline (framing, backpressure, hashing, DataChannel
      // throughput, storage write) from real disk I/O. Shares every other
      // byte of the real send path via startSendingCore — this is not a
      // parallel mock, it's the exact same SenderEngine.
      const sendableFiles: SendableFile[] = [
        {
          fileIndex: 0,
          name: `benchmark-${Math.round(sizeBytes / (1024 * 1024))}MiB.bin`,
          size: sizeBytes,
          mimeType: "application/octet-stream",
          source: new SyntheticChunkSource(sizeBytes)
        }
      ];
      await startSendingCore(sendableFiles);
    },

    async startReceiving(joinBy) {
      teardown();
      set({
        role: "receiver",
        phase: "waiting-for-peer",
        errorMessage: null,
        files: [],
        readyFiles: [],
        incomingOffer: null,
        diagnostics: DEFAULT_DIAGNOSTICS,
        connectionStage: "preparing",
        controlChannelState: "none",
        dataChannelState: "none",
        bufferedAmount: 0,
        chunkSize: null,
        sustainedMBs: 0,
        peakMBs: 0,
        connectionTimeline: []
      });

      signaling = new SignalingClient(resolveSignalingUrl());
      watchSignalingState(signaling);
      stopNetworkWatch?.();
      stopNetworkWatch = startNetworkWatch();
      try {
        await waitForSignalingOpen(signaling);
      } catch {
        if (!TERMINAL_PHASES.has(get().phase)) {
          set({ phase: "failed", errorMessage: "Could not reach the signaling server. Check your connection and try again." });
        }
        return;
      }

      signaling.send({ type: "join-room", code: joinBy.code, roomId: joinBy.roomId });
      bindLifecycleSignaling(signaling);
      // Kicked off now, concurrently with the join-room round trip rather
      // than serially after it — same reasoning as the sender side.
      void requestIceServers(new URLSearchParams(window.location.search).get("noTurn") === "1");

      signaling.onMessage((msg) => {
        if (msg.type === "joined") {
          savedRoomId = msg.roomId;
          savedPeerId = msg.peerId;
          savedIsInitiator = msg.isInitiator;
          void setupPeerConnection(false).then(({ control, lanes }) => {
            receiverEngine = new ReceiverEngine(control, lanes);
            bindReceiverEngine(receiverEngine);
            // Reacts automatically to whatever secondary lanes the sender
            // decides to negotiate — no action needed on this side beyond
            // handing each new independent-PeerConnection lane's channel to
            // the already-running ReceiverEngine as it opens.
            stopAnswererLaneListener?.();
            stopAnswererLaneListener = listenForAnswererPeerLanes(signaling!, cachedIceServers, cachedIceTransportPolicy, (connectionId, handle) => {
              secondaryLanes.set(connectionId, handle);
              receiverEngine?.addLane(handle.dataChannel);
            });
          }).catch((err: unknown) => {
            if (!TERMINAL_PHASES.has(get().phase)) {
              set({ phase: "failed", errorMessage: err instanceof Error ? err.message : "Failed to establish a connection." });
            }
          });
        } else if (msg.type === "error") {
          set({ phase: "failed", errorMessage: msg.message });
        }
      });
    },

    acceptIncoming(acceptedIndices, rejectedIndices, sinks) {
      void receiverEngine?.accept(acceptedIndices, rejectedIndices, sinks);
      set({ incomingOffer: null });
    },

    // Benchmark mode "Benchmark A" (Phase 5 of the throughput audit):
    // accepts every offered file with a DiscardSink — bytes are received
    // over the REAL DataChannel and run through the REAL per-chunk
    // pipeline (decode, hash, backpressure) but are never persisted. This
    // isolates WebRTC+pipeline throughput from storage throughput on the
    // actual browser, so the two can be measured independently instead of
    // guessed apart.
    acceptIncomingBenchmarkDiscard() {
      const offer = get().incomingOffer;
      if (!offer) return;
      const indices = offer.files.map((f) => f.fileIndex);
      const sinks = new Map<number, FileSink>(indices.map((i) => [i, createDiscardSink()]));
      void receiverEngine?.accept(indices, [], sinks);
      set({ incomingOffer: null });
    },

    pauseFile(fileIndex) {
      senderEngine?.pause(fileIndex);
      receiverEngine?.pause(fileIndex);
    },
    resumeFile(fileIndex) {
      senderEngine?.resume(fileIndex);
      receiverEngine?.resume(fileIndex);
    },
    cancelFile(fileIndex) {
      senderEngine?.cancel(fileIndex);
      receiverEngine?.cancel(fileIndex);
    },

    reset() {
      teardown();
      set({
        role: null,
        phase: "idle",
        linkQuality: "unknown",
        roomCode: null,
        roomLink: null,
        errorMessage: null,
        incomingOffer: null,
        files: [],
        readyFiles: [],
        wakeLockActive: false,
        forcedRelay: false,
        diagnostics: DEFAULT_DIAGNOSTICS,
        connectionStage: "preparing",
        signalingState: "idle",
        controlChannelState: "none",
        dataChannelState: "none",
        bufferedAmount: 0,
        chunkSize: null,
        sustainedMBs: 0,
        peakMBs: 0,
        connectionTimeline: []
      });
    }
  };
});

// Debug surface: the full session state (bufferedAmount, control/data
// channel readyState, per-file status including "paused"/"transferring",
// connection diagnostics) inspectable live via `window.__fd9Store.getState()`
// on either side of a real transfer — the sender-side half of the
// instrumentation that complements receiver.ts's receive-diagnostics event.
if (typeof window !== "undefined") {
  (window as unknown as { __fd9Store?: typeof useSessionStore }).__fd9Store = useSessionStore;
}

export type { FileProgress, OfferedFile };
