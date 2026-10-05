// fd9 PeerConnection-scaling benchmark — standalone diagnostic tool, NOT
// part of the product. Imports fd9's REAL production modules directly
// (confirmed: Vite's dev server transforms absolute /src/*.ts imports even
// when requested from a page served out of public/), so this measures the
// actual shipped SenderEngine/ReceiverEngine/peerLane architecture through
// the real signaling server and the real Azure TURN relay — not a
// reimplementation, and not the old chunk-size/reliability matrix.
//
// Runs EXACTLY the plan specified: 1, 2, 4, 8 independent RTCPeerConnections
// (256 MiB, 256 KiB chunks, reliable+ordered, ONE run each, TURN forced for
// a clean controlled comparison since direct is already known not to work
// on this network), then one DIRECT_ONLY run (STUN only, no TURN, policy
// "all"). Receiver discards every byte (DiscardSink) to isolate transport
// throughput from storage. getStats() is polled automatically for every
// PeerConnection in every run — no DevTools inspection required.
import { SignalingClient } from "/src/lib/signalingClient.ts";
import { negotiatedMaxChunkSize, openNegotiatedChannels, toRTCIceServers, wireSignalingForPeerConnection } from "/src/lib/rtc.ts";
import { openOffererPeerLane, listenForAnswererPeerLanes } from "/src/lib/transfer/peerLane.ts";
import { SenderEngine } from "/src/lib/transfer/sender.ts";
import { ReceiverEngine } from "/src/lib/transfer/receiver.ts";
import { SyntheticChunkSource } from "/src/lib/transfer/benchmarkSource.ts";
import { createDiscardSink } from "/src/lib/transfer/sinks.ts";

const log = (...args) => {
  const el = document.getElementById("log");
  el.textContent += args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n";
  el.scrollTop = el.scrollHeight;
  console.log("[pc-scaling-bench]", ...args);
};

function setStatus(s) {
  document.getElementById("status").textContent = s;
}

// PUBLIC-TUNNEL OVERRIDE: when this page itself is loaded through a public
// tunnel (e.g. a real physical Mac<->iPhone test where the devices can't
// reach each other's local IP directly), the signaling server is reachable
// through its OWN separate tunnel URL, not <this page's hostname>:8787 —
// Cloudflare quick tunnels only expose 443/wss, never an arbitrary port.
// Append ?signaling=<url> to override; otherwise falls back to the normal
// local-dev behavior unchanged.
function resolveSignalingUrl() {
  const override = new URLSearchParams(window.location.search).get("signaling");
  if (override) return override;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:8787`;
}

const TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB, per spec — the ONLY size ever used for the real throughput table
const TARGET_CHUNK_SIZE = 256 * 1024; // 256 KiB, per spec — clamped per-connection against negotiatedMaxChunkSize(pc0) below, since the raw payload size needs headroom for the 14-byte chunk-frame header within this connection's REAL negotiated SCTP max-message-size

// Small, fixed, connectivity/negotiation-only payload. NEVER used for the
// real throughput table — see runSmokeTestAsSender/runFullSweepAsSender,
// which write to entirely separate result arrays and DOM elements so a
// smoke-test number can never be mistaken for a real one.
const SMOKE_BYTES = 4 * 1024 * 1024;
const SMOKE_PLAN = [
  { label: "Smoke: 1 PC (TURN forced)", laneCount: 1, directOnly: false, isSmoke: true },
  { label: "Smoke: 2 PC (TURN forced)", laneCount: 2, directOnly: false, isSmoke: true }
];

// The exact, fixed plan — both roles hardcode this identically so the
// receiver can independently compute the same iceServers/policy per run
// without needing a new signaling message type (the signaling protocol's
// existing schemas don't carry arbitrary extra metadata).
const RUN_PLAN = [
  { label: "1 PC (TURN forced)", laneCount: 1, directOnly: false, isSmoke: false },
  { label: "2 PC (TURN forced)", laneCount: 2, directOnly: false, isSmoke: false },
  { label: "4 PC (TURN forced)", laneCount: 4, directOnly: false, isSmoke: false },
  { label: "8 PC (TURN forced)", laneCount: 8, directOnly: false, isSmoke: false },
  { label: "1 PC (DIRECT-ONLY, STUN only)", laneCount: 1, directOnly: true, isSmoke: false }
];

// ONE combined, strictly ordered sequence both sender and receiver index
// into identically — the receiver detects "the Nth primary-connection
// offer ever seen in this paired session" and just looks up COMBINED_PLAN[N],
// so running the smoke test BEFORE the real sweep (the required order) is
// all that's needed to keep both sides in sync, with zero new signaling.
const COMBINED_PLAN = [...SMOKE_PLAN, ...RUN_PLAN];

function stripTurn(iceServers) {
  return iceServers
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u.startsWith("stun:")) }))
    .filter((s) => s.urls.length > 0);
}

function resolveRunIceServers(allIceServers, run) {
  return run.directOnly ? stripTurn(allIceServers) : allIceServers;
}

function resolveRunPolicy(run) {
  return run.directOnly ? "all" : "relay";
}

let signaling = null;
let allIceServers = null;
// Shared, strictly sequential index into COMBINED_PLAN — the receiver's
// own detector increments an identical counter per primary-connection
// offer it sees, so as long as the smoke test runs BEFORE the real sweep
// (the required order), both sides stay in lockstep with zero new
// signaling needed to announce "which run this is."
let nextPlanIndex = 0;

function waitOpen(client) {
  return new Promise((resolve) => {
    if (client.state === "open") {
      resolve();
      return;
    }
    const unsub = client.onStateChange((s) => {
      if (s === "open") {
        unsub();
        resolve();
      }
    });
  });
}

function waitForMsg(client, type, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    const unsub = client.onMessage((msg) => {
      if (msg.type === type) {
        clearTimeout(timer);
        unsub();
        resolve(msg);
      } else if (msg.type === "error") {
        clearTimeout(timer);
        unsub();
        reject(new Error(`signaling error: ${JSON.stringify(msg)}`));
      }
    });
  });
}

function fetchIceServers() {
  return new Promise((resolve) => {
    const unsub = signaling.onMessage((msg) => {
      if (msg.type === "turn-credentials") {
        unsub();
        resolve(toRTCIceServers(msg.servers));
      }
    });
    signaling.send({ type: "request-turn-credentials" });
  });
}

/** One getStats() snapshot for one RTCPeerConnection — the exact fields item 15 asked for. */
async function snapshotPc(pc) {
  const out = {
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
    localType: null,
    remoteType: null,
    relayProtocol: null,
    rttMs: null,
    bytesSent: 0,
    bytesReceived: 0,
    packetsSent: null,
    packetsReceived: null,
    availableOutgoingBitrate: null,
    // Not a standard RTCIceCandidatePairStats/data-channel field for pure
    // SCTP DataChannel transport (it's an RTP-media-stream concept) — left
    // null rather than fabricated if getStats() never exposes it here.
    retransmittedBytesSent: null,
    dataChannelBytesSent: null,
    dataChannelBytesReceived: null
  };
  try {
    const stats = await pc.getStats();
    const candidates = new Map();
    let localId, remoteId;
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && (r.state === "succeeded" || r.nominated)) {
        localId = r.localCandidateId;
        remoteId = r.remoteCandidateId;
        if (typeof r.currentRoundTripTime === "number") out.rttMs = Math.round(r.currentRoundTripTime * 1000);
        if (typeof r.bytesSent === "number") out.bytesSent = r.bytesSent;
        if (typeof r.bytesReceived === "number") out.bytesReceived = r.bytesReceived;
        if (typeof r.packetsSent === "number") out.packetsSent = r.packetsSent;
        if (typeof r.packetsReceived === "number") out.packetsReceived = r.packetsReceived;
        if (typeof r.availableOutgoingBitrate === "number") out.availableOutgoingBitrate = r.availableOutgoingBitrate;
        if (typeof r.retransmittedBytesSent === "number") out.retransmittedBytesSent = r.retransmittedBytesSent;
      }
      if (r.type === "local-candidate" || r.type === "remote-candidate") candidates.set(r.id, r);
      // Exclude the "control" channel's own stats — only the bulk/data
      // lane's throughput is what this experiment is measuring.
      if (r.type === "data-channel" && r.label !== "control") {
        out.dataChannelBytesSent = (out.dataChannelBytesSent ?? 0) + (r.bytesSent ?? 0);
        out.dataChannelBytesReceived = (out.dataChannelBytesReceived ?? 0) + (r.bytesReceived ?? 0);
      }
    });
    if (localId) {
      const lc = candidates.get(localId);
      const rc = candidates.get(remoteId);
      out.localType = lc?.candidateType ?? null;
      out.remoteType = rc?.candidateType ?? null;
      out.relayProtocol = lc?.relayProtocol ?? rc?.relayProtocol ?? null;
    }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

/** Live DataChannel.bufferedAmount sampling — not part of getStats(), a direct property read instead. Polled alongside snapshotPc() during the transfer so bufferedAmount behavior over time can be reported, not just a single instantaneous value. */
function sampleBufferedAmount(dataChannel) {
  return dataChannel.bufferedAmount;
}

function startStatsPolling(pcs, onSample) {
  const id = setInterval(() => {
    void Promise.all(pcs.map((pc) => snapshotPc(pc))).then(onSample);
  }, 1000);
  return () => clearInterval(id);
}

// openNegotiatedChannels()'s ready promise (rtc.ts, production code — left
// untouched) only resolves on DataChannel.onopen, with no timeout of its
// own. That's fine for TURN (sub-second in every run observed here), but a
// genuinely blocked direct/STUN-only path (e.g. cellular NAT with no relay)
// can leave it pending forever. This timeout is benchmark-local only — it
// changes how THIS SCRIPT awaits that promise, not the promise itself or
// anything production code relies on.
const PRIMARY_CONNECTION_TIMEOUT_MS = 30000;
function waitWithTimeout(promise, label, ms = PRIMARY_CONNECTION_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// ========================= SENDER ROLE =========================

async function runOneAsSender(run, planIndex, sizeBytes) {
  const runIceServers = resolveRunIceServers(allIceServers, run);
  const policy = resolveRunPolicy(run);
  const kind = run.isSmoke ? "SMOKE" : "run";
  log(`[${kind} ${planIndex}] ${run.label} — requestedLanes=${run.laneCount} policy=${policy} iceServers=${runIceServers.length} requestedBytes=${sizeBytes}`);

  const pc0 = new RTCPeerConnection({ iceServers: runIceServers, iceTransportPolicy: policy });
  const channels = openNegotiatedChannels(pc0, 1);
  // Every run's primary connection shares the SAME connectionId sentinel
  // (undefined) — unlike real production usage (one primary connection per
  // page load, forever), this benchmark negotiates several in sequence, so
  // the listener for THIS run's primary connection must be torn down before
  // the next run's offer/answer would otherwise be delivered to it too.
  const unwirePrimary = wireSignalingForPeerConnection(signaling, pc0);

  const tPrimary0 = performance.now();
  const offer = await pc0.createOffer();
  await pc0.setLocalDescription(offer);
  signaling.send({ type: "relay-sdp", payload: { type: "offer", sdp: offer.sdp ?? "" } });
  await waitWithTimeout(channels.ready, `[${kind} ${planIndex}] primary connection (offerer)`);
  const primaryEstablishMs = Math.round(performance.now() - tPrimary0);
  // Unwire NOW, not at the end of the run — ICE candidate trickling for
  // this connection is done by the time the data channel can open, and
  // there is no cross-page guarantee that the receiver has finished ITS
  // OWN equivalent cleanup before this run's "file-complete" round-trip
  // lets the sweep loop move on to the next run's offer (same
  // connectionId=undefined sentinel) — unwiring late left a real race.
  unwirePrimary();
  // The REAL negotiated ceiling for this specific connection — observed to
  // be exactly 262144 (256 KiB) on this link, meaning a 256 KiB PAYLOAD
  // plus the 14-byte chunk-frame header exceeds it by 14 bytes and throws
  // "message larger than max-message-size". Target 256 KiB but never
  // exceed what this connection can actually carry, same as production.
  const chunkSize = Math.min(TARGET_CHUNK_SIZE, negotiatedMaxChunkSize(pc0));
  log(`[${kind} ${planIndex}] primary connection open (${primaryEstablishMs}ms) — negotiated max chunk size=${chunkSize}`);

  // Secondary lanes: sequential (never fired concurrently — one full
  // negotiation, including its TURN allocation, completes before the next
  // one starts), retried once on failure (openOffererPeerLaneWithRetry),
  // and a lane that STILL fails after retry does NOT abort the run — it's
  // recorded as failed and the transfer proceeds with however many lanes
  // actually connected. "Requested 8 lanes" and "connected 8 lanes" are
  // reported as separate, explicit numbers, never conflated.
  const laneHandles = [];
  const failedLaneIds = [];
  const laneEstablishMs = [primaryEstablishMs];
  const laneRetried = [false]; // parallel to laneEstablishMs/laneHandles — did THIS lane need its one retry?
  for (let i = 1; i < run.laneCount; i++) {
    const connectionId = `${run.isSmoke ? "smoke" : "run"}${planIndex}-lane${i}`;
    const tLane0 = performance.now();
    let retried = false;
    try {
      let handle;
      try {
        handle = await openOffererPeerLane(signaling, runIceServers, policy, connectionId);
      } catch (firstErr) {
        retried = true;
        log(`[${kind} ${planIndex}] secondary lane ${i} first attempt failed (${firstErr && firstErr.message}) — retrying once with a fresh connectionId`);
        handle = await openOffererPeerLane(signaling, runIceServers, policy, `${connectionId}-retry1`);
      }
      const ms = Math.round(performance.now() - tLane0);
      laneEstablishMs.push(ms);
      laneRetried.push(retried);
      handle.onFailed(() => log(`[${kind} ${planIndex}] lane ${i} FAILED unexpectedly after establishment`));
      laneHandles.push(handle);
      log(`[${kind} ${planIndex}] secondary lane ${i} open (${ms}ms)${retried ? " [needed 1 retry]" : ""}`);
    } catch (err) {
      failedLaneIds.push(connectionId);
      log(`[${kind} ${planIndex}] secondary lane ${i} FAILED to establish even after one retry: ${err && err.message}`);
    }
  }
  const connectedLaneCount = 1 + laneHandles.length;
  if (connectedLaneCount < run.laneCount) {
    log(`[${kind} ${planIndex}] WARNING: only ${connectedLaneCount}/${run.laneCount} requested lanes connected — continuing with fewer lanes, not aborting the run`);
  }

  const allLanes = [channels.lanes[0], ...laneHandles.map((h) => h.dataChannel)];
  const allPcs = [pc0, ...laneHandles.map((h) => h.pc)];

  const file = {
    fileIndex: 0,
    name: `pc-scaling-${run.laneCount}pc${run.isSmoke ? "-smoke" : ""}.bin`,
    size: sizeBytes,
    mimeType: "application/octet-stream",
    source: new SyntheticChunkSource(sizeBytes)
  };
  // initialActiveLanes = however many ACTUALLY connected, no growLane ->
  // stays fixed at exactly that many lanes for the whole run. This is a
  // controlled measurement, not the adaptive controller.
  const sender = new SenderEngine(channels.control, allLanes, [file], chunkSize, undefined, undefined, connectedLaneCount);

  let peakMBs = 0;
  let lastBytes = 0;
  let lastT = performance.now();
  const stopStats = startStatsPolling(allPcs, () => {});

  // bufferedAmount is a live DataChannel property, not part of getStats() —
  // sampled on the same 1s cadence as the PC stats poll so its behavior
  // over the WHOLE transfer (not one instant) can be reported.
  let bufferedMin = Infinity;
  let bufferedMax = 0;
  const bufferedSampleId = setInterval(() => {
    const b = sampleBufferedAmount(allLanes[0]);
    bufferedMin = Math.min(bufferedMin, b);
    bufferedMax = Math.max(bufferedMax, b);
  }, 1000);

  const t0 = performance.now();
  const done = new Promise((resolve) => {
    sender.on("progress", (files) => {
      const f = files[0];
      if (!f) return;
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      if (dt > 0.2) {
        const mbs = (f.confirmedBytes - lastBytes) / (1024 * 1024) / dt;
        peakMBs = Math.max(peakMBs, mbs);
        lastBytes = f.confirmedBytes;
        lastT = now;
      }
      if (f.status === "completed" || f.status === "failed") resolve(f);
    });
  });
  void sender.offer();
  const finalFile = await done;
  const elapsedMs = performance.now() - t0;
  stopStats();
  clearInterval(bufferedSampleId);

  const finalStats = await Promise.all(allPcs.map((pc) => snapshotPc(pc)));
  // Per-lane throughput: each lane's own dataChannel payload bytes over the
  // SAME wall-clock duration as the whole run — an average, not that lane's
  // own peak, but it directly answers "how much did lane i actually carry."
  const perLaneMBs = finalStats.map((s) => (s.dataChannelBytesSent ?? 0) / (1024 * 1024) / (elapsedMs / 1000));
  finalStats.forEach((s, i) => {
    log(
      `[${kind} ${planIndex}] lane ${i}: connectionState=${s.connectionState} local=${s.localType} remote=${s.remoteType} relayProto=${s.relayProtocol} rtt=${s.rttMs}ms transportBytesSent=${s.bytesSent} packetsSent=${s.packetsSent} packetsReceived=${s.packetsReceived} availableOutgoingBitrate=${s.availableOutgoingBitrate} retransmittedBytesSent=${s.retransmittedBytesSent} payloadBytesSent(dataChannel)=${s.dataChannelBytesSent} throughput=${perLaneMBs[i].toFixed(2)}MiB/s${laneRetried[i] ? " [retried]" : ""}`
    );
  });
  log(`[${kind} ${planIndex}] lane 0 bufferedAmount over transfer: min=${bufferedMin === Infinity ? 0 : bufferedMin} max=${bufferedMax} bytes`);
  const transportBytesSent = finalStats.reduce((sum, s) => sum + (s.bytesSent || 0), 0);

  for (const h of laneHandles) h.close();
  pc0.close(); // unwirePrimary() already called right after channels.ready, above

  // confirmedBytes reflects only the LAST periodic chunk-ack, which can
  // legitimately lag the true total even for a fully successful,
  // hash-verified transfer — "completed" status is the authoritative
  // correctness signal. "verified" additionally requires the ACTUAL
  // delivered byte count to exactly equal the REQUESTED size — per spec,
  // a run is only a valid throughput data point if the full requested
  // payload was actually transferred and hash-verified, not merely
  // reported "completed".
  const actualPayloadBytes = finalFile.status === "completed" ? file.size : finalFile.confirmedBytes;
  const verified = finalFile.status === "completed" && actualPayloadBytes === sizeBytes;
  const avgMBs = actualPayloadBytes / (1024 * 1024) / (elapsedMs / 1000);
  const deliveryPct = (actualPayloadBytes / sizeBytes) * 100;
  log(
    `[${kind} ${planIndex}] DONE: ${run.label} -> requestedBytes=${sizeBytes} actualPayloadBytes=${actualPayloadBytes} transportBytesSent=${transportBytesSent} verified=${verified} avg=${avgMBs.toFixed(2)}MiB/s peak=${peakMBs.toFixed(2)}MiB/s delivery=${deliveryPct.toFixed(2)}% status=${finalFile.status}${finalFile.error ? ` error=${finalFile.error}` : ""}`
  );

  return {
    label: run.label,
    requestedLanes: run.laneCount,
    connectedLanes: connectedLaneCount,
    failedLanes: failedLaneIds,
    requestedBytes: sizeBytes,
    actualPayloadBytes,
    transportBytesSent,
    verified,
    durationMs: Math.round(elapsedMs),
    avgMBs,
    peakMBs,
    deliveryPct,
    status: finalFile.status,
    laneEstablishMs,
    laneRetried,
    perLaneMBs,
    finalStats
  };
}

/**
 * Small, fixed-size (SMOKE_BYTES) connectivity/negotiation check — writes
 * to its OWN separate results area (#smokeResultsTable), never to
 * window.__pcScalingResults or the main #resultsTable, so a smoke number
 * can never be mistaken for a real throughput measurement. Run this
 * first; it must complete (lanes establishing reliably, exact byte count
 * verified) before the real 256 MiB sweep is worth running at all.
 */
async function runSmokeTestAsSender() {
  const results = [];
  for (const run of SMOKE_PLAN) {
    const planIndex = nextPlanIndex++;
    log(`\n=== Starting SMOKE ${planIndex}: ${run.label} ===`);
    try {
      results.push(await runOneAsSender(run, planIndex, SMOKE_BYTES));
    } catch (err) {
      log(`[SMOKE ${planIndex}] FAILED: ${err && err.message}`);
      results.push({ label: run.label, requestedLanes: run.laneCount, connectedLanes: 0, failedLanes: [], requestedBytes: SMOKE_BYTES, actualPayloadBytes: 0, transportBytesSent: 0, verified: false, durationMs: 0, avgMBs: 0, peakMBs: 0, deliveryPct: 0, status: "error", laneEstablishMs: [], laneRetried: [], perLaneMBs: [], finalStats: [] });
    }
    renderSmokeResults(results);
  }
  log("\n=== SMOKE TEST COMPLETE ===");
  const allVerified = results.every((r) => r.verified);
  const allLanesConnected = results.every((r) => r.connectedLanes === r.requestedLanes);
  log(`[smoke] all runs byte-verified: ${allVerified}; all requested lanes connected on every run: ${allLanesConnected}`);
  if (!allVerified || !allLanesConnected) {
    log("[smoke] NOT clean — investigate before running the real 256 MiB sweep.");
  } else {
    log("[smoke] clean — safe to proceed to the real sweep.");
  }
}

async function runFullSweepAsSender() {
  const results = [];
  for (const run of RUN_PLAN) {
    const planIndex = nextPlanIndex++;
    log(`\n=== Starting run ${planIndex}: ${run.label} ===`);
    try {
      results.push(await runOneAsSender(run, planIndex, TOTAL_BYTES));
    } catch (err) {
      log(`[run ${planIndex}] FAILED: ${err && err.message}`);
      results.push({ label: run.label, requestedLanes: run.laneCount, connectedLanes: 0, failedLanes: [], requestedBytes: TOTAL_BYTES, actualPayloadBytes: 0, transportBytesSent: 0, verified: false, durationMs: 0, avgMBs: 0, peakMBs: 0, deliveryPct: 0, status: "error", laneEstablishMs: [], laneRetried: [], perLaneMBs: [], finalStats: [] });
    }
    renderResults(results);
  }
  log("\n=== SWEEP COMPLETE ===");
}

// ========================= RECEIVER ROLE =========================

let receiverPlanIndex = 0;
let stopCurrentAnswererLanes = null;

function startReceiverRunDetector() {
  signaling.onMessage((msg) => {
    if (msg.type !== "relay-sdp" || msg.payload.type !== "offer" || msg.payload.connectionId) return;
    // A new PRIMARY-connection offer with no connectionId = the start of
    // the next entry in COMBINED_PLAN (smoke entries first, then the real
    // sweep) — identical shared sequential index as the sender side.
    const planIndex = receiverPlanIndex++;
    if (planIndex >= COMBINED_PLAN.length) {
      log(`unexpected extra primary offer beyond the planned ${COMBINED_PLAN.length} runs — ignoring`);
      return;
    }
    void handleRunAsReceiver(COMBINED_PLAN[planIndex], planIndex, msg.payload.sdp);
  });
}

async function handleRunAsReceiver(run, runIndex, offerSdp) {
  const kind = run.isSmoke ? "SMOKE" : "run";
  const sizeBytes = run.isSmoke ? SMOKE_BYTES : TOTAL_BYTES;
  log(`\n=== Receiver: ${kind} ${runIndex}: ${run.label} ===`);
  const runIceServers = resolveRunIceServers(allIceServers, run);
  const policy = resolveRunPolicy(run);

  const pc0 = new RTCPeerConnection({ iceServers: runIceServers, iceTransportPolicy: policy });
  const channels = openNegotiatedChannels(pc0, 1);
  // Same cross-run stale-listener hazard as the sender side — must be torn
  // down before the NEXT run's primary offer arrives (see runOneAsSender).
  const unwirePrimary = wireSignalingForPeerConnection(signaling, pc0);

  // Handle THIS already-captured offer inline — wireSignalingForPeerConnection,
  // just registered above, is too late to see a message that already
  // finished dispatching to the handlers that existed at delivery time.
  await pc0.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await pc0.createAnswer();
  await pc0.setLocalDescription(answer);
  signaling.send({ type: "relay-sdp", payload: { type: "answer", sdp: answer.sdp ?? "" } });

  try {
    await waitWithTimeout(channels.ready, `[${kind} ${runIndex}] primary connection (answerer)`);
  } catch (err) {
    log(`[${kind} ${runIndex}] (receiver) FAILED: ${err && err.message}`);
    unwirePrimary();
    pc0.close();
    return;
  }
  // Unwire NOW, not at the end of the run — same reasoning as the sender
  // side: no cross-page guarantee the sender hasn't already started the
  // NEXT run's offer (same connectionId=undefined sentinel) by the time
  // this run's full transfer finishes.
  unwirePrimary();
  log(`[${kind} ${runIndex}] primary connection open (receiver)`);

  const receiver = new ReceiverEngine(channels.control, [channels.lanes[0]]);
  const lanePcs = [pc0];
  stopCurrentAnswererLanes?.();
  stopCurrentAnswererLanes = listenForAnswererPeerLanes(signaling, runIceServers, policy, (connectionId, handle) => {
    receiver.addLane(handle.dataChannel);
    lanePcs.push(handle.pc);
    log(`[${kind} ${runIndex}] secondary lane ${connectionId} open (receiver)`);
  });

  receiver.on("offer", (offer) => {
    void receiver.accept(offer.files.map((f) => f.fileIndex), [], new Map([[0, createDiscardSink()]]));
  });

  const stopStats = startStatsPolling(lanePcs, () => {}); // samples not needed receiver-side beyond the final snapshot; sender's table is authoritative

  const done = new Promise((resolve) => {
    receiver.on("progress", (files) => {
      const f = files[0];
      if (f && (f.status === "completed" || f.status === "failed")) resolve(f);
    });
  });
  const finalFile = await done;
  stopStats();
  stopCurrentAnswererLanes?.();
  stopCurrentAnswererLanes = null;

  const finalStats = await Promise.all(lanePcs.map((pc) => snapshotPc(pc)));
  finalStats.forEach((s, i) => {
    log(`[${kind} ${runIndex}] (receiver) lane ${i}: connectionState=${s.connectionState} local=${s.localType} remote=${s.remoteType} relayProto=${s.relayProtocol} rtt=${s.rttMs}ms payloadBytesReceived(dataChannel)=${s.dataChannelBytesReceived}`);
  });
  const actualPayloadBytes = finalFile.status === "completed" ? sizeBytes : finalFile.confirmedBytes;
  const verified = finalFile.status === "completed" && actualPayloadBytes === sizeBytes;
  log(`[${kind} ${runIndex}] (receiver) DONE: status=${finalFile.status} requestedBytes=${sizeBytes} actualPayloadBytes=${actualPayloadBytes} verified=${verified} connectedLanes=${lanePcs.length}`);

  for (const pc of lanePcs) pc.close(); // unwirePrimary() already called right after channels.ready, above
}

// ========================= results tables =========================
// Smoke-test results and real-sweep results are rendered into COMPLETELY
// SEPARATE DOM elements and SEPARATE window globals — a smoke number can
// never end up in the same table as a real one, by construction.

const RESULT_HEADERS = ["Lanes req/conn", "Label", "Requested Bytes", "Actual Payload Bytes", "Transport Bytes", "Verified", "Duration(s)", "Avg MiB/s", "Peak MiB/s", "Per-Lane MiB/s", "RTT(ms)/lane", "Local/lane", "Remote/lane", "RelayProto/lane", "Lane Establish(ms)", "Lane Retries", "Failed Lanes", "Status"];

function resultRow(r) {
  const stats = r.finalStats || [];
  return [
    `${r.requestedLanes}/${r.connectedLanes}`,
    r.label,
    r.requestedBytes,
    r.actualPayloadBytes,
    r.transportBytesSent,
    r.verified ? "YES" : "no",
    (r.durationMs / 1000).toFixed(1),
    r.avgMBs.toFixed(2),
    r.peakMBs.toFixed(2),
    (r.perLaneMBs || []).map((v) => v.toFixed(2)).join(","),
    stats.map((p) => p.rttMs ?? "—").join(","),
    stats.map((p) => p.localType ?? "—").join(","),
    stats.map((p) => p.remoteType ?? "—").join(","),
    stats.map((p) => p.relayProtocol ?? "—").join(","),
    (r.laneEstablishMs || []).join(","),
    (r.laneRetried || []).filter(Boolean).length,
    (r.failedLanes || []).join(",") || "—",
    r.status
  ];
}

function renderTable(elementId, results) {
  let html = "<table><tr>" + RESULT_HEADERS.map((h) => `<th>${h}</th>`).join("") + "</tr>";
  for (const r of results) {
    html += "<tr>" + resultRow(r).map((v) => `<td>${v}</td>`).join("") + "</tr>";
  }
  html += "</table>";
  document.getElementById(elementId).innerHTML = html;
}

function asMarkdown(results) {
  let md = "| " + RESULT_HEADERS.join(" | ") + " |\n";
  md += "|" + RESULT_HEADERS.map(() => "---").join("|") + "|\n";
  for (const r of results) {
    md += "| " + resultRow(r).join(" | ") + " |\n";
  }
  return md;
}

function renderResults(results) {
  window.__pcScalingResults = results; // the REAL 256 MiB sweep — the only results meant to answer the throughput question
  renderTable("resultsTable", results);
  document.getElementById("copyBtn").disabled = results.length === 0;
}

function renderSmokeResults(results) {
  window.__pcScalingSmokeResults = results; // connectivity/negotiation check ONLY — never a throughput answer
  renderTable("smokeResultsTable", results);
  document.getElementById("copySmokeBtn").disabled = results.length === 0;
}

// ========================= UI wiring =========================

document.getElementById("createBtn").onclick = async () => {
  setStatus("connecting signaling...");
  signaling = new SignalingClient(resolveSignalingUrl());
  await waitOpen(signaling);
  signaling.send({ type: "create-room" });
  const created = await waitForMsg(signaling, "room-created");
  document.getElementById("roomCodeDisplay").textContent = `Room code: ${created.code}`;
  setStatus("waiting for peer...");
  await waitForMsg(signaling, "peer-joined", 300000);
  setStatus("fetching ICE servers...");
  allIceServers = await fetchIceServers();
  setStatus("ready — run the smoke test first");
  document.getElementById("smokeBtn").disabled = false;
};

document.getElementById("joinBtn").onclick = async () => {
  const code = document.getElementById("codeInput").value.trim().toUpperCase();
  setStatus("connecting signaling...");
  signaling = new SignalingClient(resolveSignalingUrl());
  await waitOpen(signaling);
  signaling.send({ type: "join-room", code });
  await waitForMsg(signaling, "joined");
  setStatus("fetching ICE servers...");
  allIceServers = await fetchIceServers();
  setStatus("ready — waiting for sender to start the sweep");
  startReceiverRunDetector();
};

document.getElementById("smokeBtn").onclick = async () => {
  document.getElementById("smokeBtn").disabled = true;
  setStatus("running smoke test...");
  await runSmokeTestAsSender();
  setStatus("smoke test complete — review before running the real sweep");
  document.getElementById("startBtn").disabled = false;
};

document.getElementById("startBtn").onclick = async () => {
  document.getElementById("startBtn").disabled = true;
  setStatus("running full 256 MiB sweep...");
  await runFullSweepAsSender();
  setStatus("sweep complete");
};

document.getElementById("copySmokeBtn").onclick = () => {
  const md = asMarkdown(window.__pcScalingSmokeResults || []);
  void navigator.clipboard?.writeText(md);
  log("Copied SMOKE results as Markdown.");
};

document.getElementById("copyBtn").onclick = () => {
  const md = asMarkdown(window.__pcScalingResults || []);
  void navigator.clipboard?.writeText(md);
  log("Copied results as Markdown.");
};
