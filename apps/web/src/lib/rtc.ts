import { CHUNK_FRAME, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, type TurnServer } from "@fd9/protocol";
import type { SignalingClient } from "./signalingClient.js";
import type { ControlChannel, DataChannel } from "./transfer/channels.js";

export type LinkQuality = "direct" | "relayed" | "unknown";

/**
 * Reads the real, negotiated SCTP max-message-size for this specific
 * connection (both browsers' capabilities, already reconciled) instead of
 * guessing a chunk size — bigger chunks mean less per-message overhead and
 * higher achievable throughput, bounded by what this exact link actually
 * supports. Falls back to a conservative default where the browser doesn't
 * expose it (`RTCPeerConnection.sctp` isn't universal yet).
 */
export function negotiatedMaxChunkSize(pc: RTCPeerConnection): number {
  const sctpMax = pc.sctp?.maxMessageSize;
  if (!sctpMax || !Number.isFinite(sctpMax) || sctpMax <= 0) return DEFAULT_CHUNK_SIZE;
  const safetyMargin = 1024;
  const candidate = sctpMax - CHUNK_FRAME.headerBytes - safetyMargin;
  return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, candidate));
}

/**
 * Buffers inbound ICE candidates for `peerConn` until its remote
 * description is actually set (addIceCandidate throws before then), and
 * relays the offer/answer exchange: an incoming offer gets auto-answered,
 * an incoming answer completes this side's own earlier offer. Filters
 * every relay-sdp/relay-ice message by `connectionId` — `undefined`
 * matches only the session's PRIMARY connection (the common, pre-existing
 * case), any other value matches exactly one independent secondary lane
 * (see transfer/peerLane.ts), so any number of simultaneous negotiations
 * can share this one signaling WebSocket without cross-talk.
 */
function bindPeerSignaling(client: SignalingClient, peerConn: RTCPeerConnection, connectionId?: string): () => void {
  const pendingCandidates: RTCIceCandidateInit[] = [];
  // Reflect the connection's ACTUAL current state — a reconnect re-attaches
  // this to a peerConn that may already have a remote description set, and
  // must not re-queue candidates that would then never get flushed.
  let remoteDescriptionReady = peerConn.remoteDescription !== null;

  async function flushPendingCandidates(): Promise<void> {
    remoteDescriptionReady = true;
    while (pendingCandidates.length > 0) {
      const candidate = pendingCandidates.shift()!;
      try {
        await peerConn.addIceCandidate(candidate);
      } catch {
        /* a stale/invalid candidate — not fatal, ICE just has one fewer option to try */
      }
    }
  }

  return client.onMessage((msg) => {
    if (msg.type === "relay-sdp") {
      if (msg.payload.connectionId !== connectionId) return;
      if (msg.payload.type === "offer") {
        void peerConn.setRemoteDescription({ type: "offer", sdp: msg.payload.sdp }).then(async () => {
          await flushPendingCandidates();
          const answer = await peerConn.createAnswer();
          await peerConn.setLocalDescription(answer);
          client.send({ type: "relay-sdp", payload: { type: "answer", sdp: answer.sdp ?? "", connectionId } });
        });
      } else {
        void peerConn.setRemoteDescription({ type: "answer", sdp: msg.payload.sdp }).then(flushPendingCandidates);
      }
    } else if (msg.type === "relay-ice") {
      if (msg.payload.connectionId !== connectionId) return;
      const candidate: RTCIceCandidateInit = {
        candidate: msg.payload.candidate,
        sdpMid: msg.payload.sdpMid ?? undefined,
        sdpMLineIndex: msg.payload.sdpMLineIndex ?? undefined
      };
      if (remoteDescriptionReady) {
        void peerConn.addIceCandidate(candidate).catch(() => {
          /* a stale/invalid candidate — not fatal, ICE just has one fewer option to try */
        });
      } else {
        pendingCandidates.push(candidate);
      }
    }
  });
}

/**
 * Wires BOTH directions of SDP/ICE relay for one RTCPeerConnection over the
 * shared signaling WebSocket: sending this side's own local candidates
 * (tagged with `connectionId`) and the full bindPeerSignaling receive-side
 * relay above. The one call every PeerConnection in a session needs —
 * the primary connection (connectionId omitted) and every independent
 * secondary lane (its own connectionId) call this exactly once.
 *
 * Returns an unsubscribe function. Production's one-primary-connection-per-
 * page-load call sites don't need it (the listener simply lives as long as
 * the session does), but anything that negotiates MULTIPLE sequential
 * connections sharing the same connectionId sentinel over one signaling
 * WebSocket (e.g. a benchmark tool running several runs back to back) must
 * call it once a connection is done with, or the next run's offer/answer
 * gets delivered to every prior run's now-closed RTCPeerConnection too.
 */
export function wireSignalingForPeerConnection(client: SignalingClient, peerConn: RTCPeerConnection, connectionId?: string): () => void {
  peerConn.onicecandidate = (event) => {
    if (event.candidate) {
      client.send({
        type: "relay-ice",
        payload: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          connectionId
        }
      });
    }
  };
  return bindPeerSignaling(client, peerConn, connectionId);
}

class RTCControlChannelAdapter implements ControlChannel {
  constructor(private readonly ch: RTCDataChannel) {}
  get readyState(): RTCDataChannelState {
    return this.ch.readyState;
  }
  send(json: string): void {
    this.ch.send(json);
  }
  onMessage(handler: (json: string) => void): void {
    this.ch.onmessage = (event) => handler(event.data as string);
  }
}

/** Exported so peerLane.ts can wrap an independent RTCPeerConnection's bulk DataChannel in the exact same adapter the primary connection uses — a lane's implementation (same-PC sibling channel vs. its own PC) is invisible past this point. */
export class RTCDataChannelAdapter implements DataChannel {
  constructor(private readonly ch: RTCDataChannel) {
    this.ch.binaryType = "arraybuffer";
  }
  get readyState(): RTCDataChannelState {
    return this.ch.readyState;
  }
  get bufferedAmount(): number {
    return this.ch.bufferedAmount;
  }
  set bufferedAmountLowThreshold(value: number) {
    this.ch.bufferedAmountLowThreshold = value;
  }
  get bufferedAmountLowThreshold(): number {
    return this.ch.bufferedAmountLowThreshold;
  }
  onBufferedAmountLow(handler: () => void): void {
    this.ch.onbufferedamountlow = handler;
  }
  send(buffer: ArrayBuffer): void {
    this.ch.send(buffer);
  }
  onMessage(handler: (buffer: ArrayBuffer) => void): void {
    this.ch.onmessage = (event) => handler(event.data as ArrayBuffer);
  }
}

export interface OpenChannels {
  control: ControlChannel;
  lanes: DataChannel[];
  ready: Promise<void>;
}

/**
 * Negotiated (not renegotiated) data channels — both peers declare the same
 * ids up front. Opens `control` (id 0) plus `laneCount` data lanes (ids
 * 1..laneCount), all multiplexed over the same RTCPeerConnection/SCTP
 * association — this needs zero signaling/protocol changes, the same way
 * `apps/web/public/bench.js` (a diagnostic tool) already proves 4
 * pre-negotiated channels work through this exact signaling server. Unused
 * lanes (when `laneCount` is less than the session's actual cap) just sit
 * open and idle; the caller's scheduler decides how many to actually use.
 */
export function openNegotiatedChannels(pc: RTCPeerConnection, laneCount = 1): OpenChannels {
  const controlRaw = pc.createDataChannel("control", { negotiated: true, id: 0, ordered: true });
  const laneRaws = Array.from({ length: laneCount }, (_, i) =>
    pc.createDataChannel(`data-${i}`, { negotiated: true, id: i + 1, ordered: true })
  );

  const waitOpen = (ch: RTCDataChannel) =>
    new Promise<void>((resolve) => {
      if (ch.readyState === "open") resolve();
      else ch.onopen = () => resolve();
    });

  const ready = Promise.all([waitOpen(controlRaw), ...laneRaws.map(waitOpen)]).then(() => undefined);

  return {
    control: new RTCControlChannelAdapter(controlRaw),
    lanes: laneRaws.map((raw) => new RTCDataChannelAdapter(raw)),
    ready
  };
}

export function toRTCIceServers(servers: TurnServer[]): RTCIceServer[] {
  return servers.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));
}

/** Candidate type as reported by getStats(): "host" | "srflx" | "prflx" | "relay". */
export type CandidateType = "host" | "srflx" | "prflx" | "relay" | null;

export interface ConnectionDiagnostics {
  quality: LinkQuality;
  iceConnectionState: RTCIceConnectionState;
  connectionState: RTCPeerConnectionState;
  /** Type of the local candidate in the currently selected/succeeded pair. */
  localCandidateType: CandidateType;
  /** Type of the remote candidate in the currently selected/succeeded pair. */
  remoteCandidateType: CandidateType;
  /** Whether a candidate pair has actually been selected (nominated/succeeded), not just gathered. */
  hasSelectedPair: boolean;
  /** Real round-trip time for the selected pair, in ms — from getStats(), not estimated. */
  rttMs: number | null;
  /** Underlying transport ("udp" | "tcp") for the local/remote candidate — tells TURN/TLS-443 (tcp) apart from normal UDP. */
  localProtocol: string | null;
  remoteProtocol: string | null;
  /** How many LOCAL candidates of each type were actually gathered — not just which one was selected. Answers "were host candidates even available?" */
  localCandidateCounts: { host: number; srflx: number; relay: number; prflx: number };
  /**
   * Per-transport TURN health — answers "which relay paths actually work",
   * not just "is TURN in use right now". "reachable" means a relay
   * candidate of that transport was actually gathered (confirmed via
   * getStats()'s relayProtocol field on local-candidate reports); "failed"
   * means only an onicecandidateerror was seen for that transport and no
   * success ever followed; "unknown" means neither happened (e.g. no server
   * configured for that transport, or ICE hasn't finished gathering yet).
   */
  turnTransports: { udp: "unknown" | "reachable" | "failed"; tcp: "unknown" | "reachable" | "failed"; tls: "unknown" | "reachable" | "failed" };
  /** Raw RTCPeerConnectionIceErrorEvent messages, one per failed candidate-gathering attempt, for the diagnostics panel / bug reports. */
  iceCandidateErrors: string[];
}

/** Classifies a STUN/TURN server URL string by the transport it actually exercises. */
function classifyTransport(url: string): "udp" | "tcp" | "tls" | null {
  if (url.startsWith("turns:")) return "tls";
  if (url.startsWith("turn:") || url.startsWith("stun:")) {
    return url.includes("transport=tcp") ? "tcp" : "udp";
  }
  return null;
}

/**
 * Polls getStats() for the real selected candidate-pair's types — never
 * inferred from connectionState alone, per the product requirement that
 * direct-vs-relay be determined from actual ICE candidate-pair statistics.
 * "relayed" quality means TURN is actually carrying this connection.
 */
export function watchConnectionDiagnostics(
  pc: RTCPeerConnection,
  onChange: (diagnostics: ConnectionDiagnostics) => void
): () => void {
  let stopped = false;

  const turnTransports: ConnectionDiagnostics["turnTransports"] = { udp: "unknown", tcp: "unknown", tls: "unknown" };
  const iceCandidateErrors: string[] = [];
  pc.onicecandidateerror = (ev) => {
    const e = ev as RTCPeerConnectionIceErrorEvent;
    iceCandidateErrors.push(`${e.errorCode} ${e.errorText} (${e.url})`);
    // STUN-only errors say nothing about TURN health — only a turn:/turns:
    // URL failing is relevant here. A later success overrides an earlier
    // failure for the same transport (a transient error during negotiation
    // isn't the same as "this transport doesn't work at all").
    if (e.url.startsWith("stun:")) return;
    const transport = classifyTransport(e.url);
    if (transport && turnTransports[transport] !== "reachable") {
      turnTransports[transport] = "failed";
    }
  };

  async function poll() {
    if (stopped) return;
    let localCandidateType: CandidateType = null;
    let remoteCandidateType: CandidateType = null;
    let localProtocol: string | null = null;
    let remoteProtocol: string | null = null;
    let hasSelectedPair = false;
    let rttMs: number | null = null;
    const localCandidateCounts = { host: 0, srflx: 0, relay: 0, prflx: 0 };

    try {
      const stats = await pc.getStats();
      let localId: string | undefined;
      let remoteId: string | undefined;
      const candidateTypes = new Map<string, CandidateType>();
      const candidateProtocols = new Map<string, string | null>();

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && (report.state === "succeeded" || report.nominated)) {
          localId = report.localCandidateId;
          remoteId = report.remoteCandidateId;
          if (typeof report.currentRoundTripTime === "number") {
            rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        }
        if (report.type === "local-candidate" || report.type === "remote-candidate") {
          candidateTypes.set(report.id, (report.candidateType as CandidateType) ?? null);
          candidateProtocols.set(report.id, (report.protocol as string | undefined) ?? null);
        }
        if (report.type === "local-candidate") {
          const t = report.candidateType as CandidateType;
          if (t === "host" || t === "srflx" || t === "relay" || t === "prflx") localCandidateCounts[t]++;
          if (t === "relay") {
            // relayProtocol ("udp"/"tcp"/"tls") is the one field that can
            // actually tell a plain TURN/TCP relay apart from a TURN/TLS
            // one — candidate.protocol alone can't (both report "tcp").
            const relayProtocol = (report as unknown as { relayProtocol?: string }).relayProtocol;
            if (relayProtocol === "udp" || relayProtocol === "tcp" || relayProtocol === "tls") {
              turnTransports[relayProtocol] = "reachable";
            }
          }
        }
      });

      if (localId && remoteId) {
        hasSelectedPair = true;
        localCandidateType = candidateTypes.get(localId) ?? null;
        remoteCandidateType = candidateTypes.get(remoteId) ?? null;
        localProtocol = candidateProtocols.get(localId) ?? null;
        remoteProtocol = candidateProtocols.get(remoteId) ?? null;
      }
    } catch {
      /* getStats can transiently fail mid-negotiation; next poll retries */
    }

    const quality: LinkQuality = !hasSelectedPair
      ? "unknown"
      : localCandidateType === "relay" || remoteCandidateType === "relay"
        ? "relayed"
        : "direct";

    onChange({
      quality,
      iceConnectionState: pc.iceConnectionState,
      connectionState: pc.connectionState,
      localCandidateType,
      remoteCandidateType,
      hasSelectedPair,
      rttMs,
      localProtocol,
      remoteProtocol,
      localCandidateCounts,
      turnTransports: { ...turnTransports },
      iceCandidateErrors: [...iceCandidateErrors]
    });

    if (!stopped) setTimeout(poll, 1000);
  }

  void poll();
  return () => {
    stopped = true;
    pc.onicecandidateerror = null;
  };
}
