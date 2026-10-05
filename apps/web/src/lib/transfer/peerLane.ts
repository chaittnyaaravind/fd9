import { RTCDataChannelAdapter, wireSignalingForPeerConnection } from "../rtc.js";
import type { SignalingClient } from "../signalingClient.js";
import type { DataChannel } from "./channels.js";

// Generous — a secondary lane's TURN allocation competing with other
// recent allocations (e.g. several lanes negotiating back to back) can
// legitimately take longer than a quick direct/STUN path would.
const LANE_NEGOTIATION_TIMEOUT_MS = 30000;

/** One independent bulk-transfer lane: its own RTCPeerConnection/ICE/DTLS/SCTP association — a genuinely separate network transport, not a sibling DataChannel on an existing connection. */
export interface PeerLaneHandle {
  dataChannel: DataChannel;
  /** Exposed read-only for diagnostics (e.g. getStats() polling) — callers should not mutate its handlers directly; use onFailed/close instead. */
  readonly pc: RTCPeerConnection;
  /** Registers a one-shot callback for when this lane's underlying connection dies unexpectedly (not a caller-initiated close). */
  onFailed(cb: () => void): void;
  /** Tears this one lane down — does not affect the primary connection or any other lane. */
  close(): void;
}

function waitForOpen(ch: RTCDataChannel, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out negotiating after ${LANE_NEGOTIATION_TIMEOUT_MS}ms`)), LANE_NEGOTIATION_TIMEOUT_MS);
    if (ch.readyState === "open") {
      clearTimeout(timer);
      resolve();
      return;
    }
    ch.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** Wires connectionState-based failure detection, the common tail of both openOffererPeerLane and listenForAnswererPeerLanes. */
function finalizeLaneHandle(pc: RTCPeerConnection, dataRaw: RTCDataChannel): PeerLaneHandle {
  let failedCb: (() => void) | null = null;
  let notified = false;
  pc.onconnectionstatechange = () => {
    if (!notified && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
      notified = true;
      failedCb?.();
    }
  };
  return {
    dataChannel: new RTCDataChannelAdapter(dataRaw),
    pc,
    onFailed: (cb) => {
      failedCb = cb;
    },
    close: () => {
      pc.onconnectionstatechange = null;
      pc.close();
    }
  };
}

/**
 * Creates a brand-new independent RTCPeerConnection for one secondary bulk
 * lane, offers it over the SAME signaling WebSocket (tagged with
 * `connectionId` so it can't cross-talk with the primary connection or any
 * other lane), and resolves once its one negotiated DataChannel is open.
 * Reuses the SAME iceServers/iceTransportPolicy as the primary connection
 * (so it naturally tends toward the same direct-vs-relay reachability
 * class — there's no public API to force candidate selection, and none is
 * needed since both PCs see the same real network).
 */
export async function openOffererPeerLane(
  signaling: SignalingClient,
  iceServers: RTCIceServer[],
  iceTransportPolicy: RTCIceTransportPolicy,
  connectionId: string
): Promise<PeerLaneHandle> {
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
  try {
    const dataRaw = pc.createDataChannel("bulk", { negotiated: true, id: 1, ordered: true });
    wireSignalingForPeerConnection(signaling, pc, connectionId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send({ type: "relay-sdp", payload: { type: "offer", sdp: offer.sdp ?? "", connectionId } });

    await waitForOpen(dataRaw, `peer lane ${connectionId} (offerer)`);
    return finalizeLaneHandle(pc, dataRaw);
  } catch (err) {
    // Otherwise this PC is abandoned but never closed — still negotiating
    // in the background (its TURN allocation doesn't know about our
    // application-level timeout), wasting a relay allocation indefinitely.
    pc.close();
    throw err;
  }
}

/**
 * Same as openOffererPeerLane, but retries ONCE with a fresh connectionId
 * (`${baseConnectionId}-retry1`) if the first attempt fails — e.g. a
 * transient TURN-allocation timeout under several lanes negotiating back
 * to back. A fresh id per attempt is required, not cosmetic: the
 * answerer's listenForAnswererPeerLanes dedupes by connectionId, so
 * reusing the same id for a retry would be silently ignored as "already
 * seen" if any part of the first attempt's offer/answer exchange actually
 * reached it before timing out. On a second failure, throws the second
 * attempt's error — the caller (e.g. SenderEngine.handleLaneFailure's
 * normal reconnect path, or a benchmark's own lane-count bookkeeping)
 * decides how to proceed with fewer lanes than requested.
 */
export async function openOffererPeerLaneWithRetry(
  signaling: SignalingClient,
  iceServers: RTCIceServer[],
  iceTransportPolicy: RTCIceTransportPolicy,
  baseConnectionId: string
): Promise<PeerLaneHandle> {
  try {
    return await openOffererPeerLane(signaling, iceServers, iceTransportPolicy, baseConnectionId);
  } catch {
    return await openOffererPeerLane(signaling, iceServers, iceTransportPolicy, `${baseConnectionId}-retry1`);
  }
}

/**
 * Registers ONE long-lived subscription (call once, receiver side only —
 * only the sender ever initiates new lanes) that recognizes a `relay-sdp`
 * offer carrying a connectionId never seen before, and automatically
 * creates the matching answerer RTCPeerConnection + DataChannel for it —
 * no user action, no separate signaling flow (requirement: additional
 * PeerConnections must not require manual signaling). Returns an unsubscribe
 * function.
 *
 * Deliberately handles the CAPTURED offer message directly (setRemoteDescription/
 * createAnswer/setLocalDescription inline) rather than re-dispatching it
 * through wireSignalingForPeerConnection's generic offer handler — that
 * generic handler is still wired up (for ICE candidates and any future
 * messages on this connectionId), but it's registered too late to see THIS
 * specific already-delivered message, so handling it inline avoids a race
 * rather than relying on re-delivery that will never happen.
 */
export function listenForAnswererPeerLanes(
  signaling: SignalingClient,
  iceServers: RTCIceServer[],
  iceTransportPolicy: RTCIceTransportPolicy,
  onNewLane: (connectionId: string, handle: PeerLaneHandle) => void
): () => void {
  const seen = new Set<string>();
  return signaling.onMessage((msg) => {
    if (msg.type !== "relay-sdp" || msg.payload.type !== "offer") return;
    const connectionId = msg.payload.connectionId;
    if (!connectionId || seen.has(connectionId)) return;
    seen.add(connectionId);

    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    void (async () => {
      const dataRaw = pc.createDataChannel("bulk", { negotiated: true, id: 1, ordered: true });
      wireSignalingForPeerConnection(signaling, pc, connectionId);

      await pc.setRemoteDescription({ type: "offer", sdp: msg.payload.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signaling.send({ type: "relay-sdp", payload: { type: "answer", sdp: answer.sdp ?? "", connectionId } });

      await waitForOpen(dataRaw, `peer lane ${connectionId} (answerer)`);
      onNewLane(connectionId, finalizeLaneHandle(pc, dataRaw));
    })().catch(() => {
      pc.close(); // otherwise abandoned but never closed, same hazard as the offerer side
      seen.delete(connectionId); // allow a retry if the sender re-offers this connectionId
    });
  });
}
