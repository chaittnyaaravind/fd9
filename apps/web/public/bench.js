// fd9 transport benchmark — standalone diagnostic tool, NOT part of the
// product. Reuses the real signaling server's existing WebSocket protocol
// (create-room/join-room/relay-sdp/relay-ice/request-turn-credentials) the
// exact same way a real pairing does, and the real TURN-credential
// endpoint — but creates its own RTCPeerConnection and raw RTCDataChannels,
// entirely separate from fd9's SenderEngine/ReceiverEngine/file-transfer
// protocol. No OPFS, no IndexedDB. Receiver discards every byte on arrival.
import { SignalingClient } from "./signalingClient.js";

const log = (...args) => {
  const el = document.getElementById("log");
  el.textContent += args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n";
  el.scrollTop = el.scrollHeight;
  console.log("[bench]", ...args);
};

function resolveSignalingUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:8787`;
}

function setStatus(s) {
  document.getElementById("status").textContent = s;
}


// The full chunk-size x reliability matrix requested. Channels are
// pre-negotiated once (ordered/reliability are immutable per-channel
// RTCDataChannelInit properties), reused across chunk-size sub-tests.
const TEST_PLAN = [
  { label: "16K ordered", channel: "reliableOrdered", chunk: 16 * 1024 },
  { label: "64K ordered", channel: "reliableOrdered", chunk: 64 * 1024 },
  { label: "256K ordered", channel: "reliableOrdered", chunk: 256 * 1024 },
  { label: "1M ordered", channel: "reliableOrdered", chunk: 1024 * 1024 },
  { label: "64K unordered", channel: "reliableUnordered", chunk: 64 * 1024 },
  { label: "256K unordered", channel: "reliableUnordered", chunk: 256 * 1024 },
  { label: "256K partial-reliable (maxRetransmits=0, best-effort)", channel: "partial", chunk: 256 * 1024 }
];

let pc, control, signaling, role, totalBytesPerTest;
const channels = {};
const results = [];

async function fetchIceServers() {
  signaling.send({ type: "request-turn-credentials" });
  const msg = await signaling.waitFor("turn-credentials");
  return msg.servers;
}

/**
 * Pure read-only instrumentation, no logic change: logs the full
 * candidate-pair/TURN picture on demand, reused by both the periodic
 * during-setup poll below and the existing post-test metrics collection.
 *
 * Unlike the original version, this dumps EVERY candidate-pair getStats()
 * reports (not just one that already succeeded) — a pair stuck in
 * "waiting"/"checking"/"failed" is exactly the evidence needed to tell
 * "no relay candidate exists" apart from "relay candidate exists but the
 * pair using it never completes connectivity checks".
 */
async function logConnectivitySnapshot(label) {
  try {
    const stats = await pc.getStats();
    const candidates = new Map();
    const pairs = [];
    stats.forEach((r) => {
      if (r.type === "candidate-pair") pairs.push(r);
      if (r.type === "local-candidate" || r.type === "remote-candidate") candidates.set(r.id, r);
    });

    const describeCandidate = (c) =>
      c ? `${c.candidateType}/${c.protocol}${c.relayProtocol ? `(relay-via-${c.relayProtocol})` : ""} ${c.ip || c.address || "?"}:${c.port ?? "?"}` : "?";

    if (pairs.length === 0) {
      log(`[conn:${label}] getStats reports ZERO candidate-pairs (ICE has not started pairing candidates yet)`);
    } else {
      log(`[conn:${label}] getStats candidate-pairs (${pairs.length} total):`);
      for (const p of pairs) {
        const lc = candidates.get(p.localCandidateId);
        const rc = candidates.get(p.remoteCandidateId);
        log(`  pair ${p.id}: state=${p.state} nominated=${!!p.nominated} local=[${describeCandidate(lc)}] remote=[${describeCandidate(rc)}]`);
      }
    }

    const anyRelayLocal = [...candidates.values()].some((c) => c.type === "local-candidate" && c.candidateType === "relay");
    const anyRelayRemote = [...candidates.values()].some((c) => c.type === "remote-candidate" && c.candidateType === "relay");
    log(`[conn:${label}] relay candidate present — local=${anyRelayLocal} remote=${anyRelayRemote}`);

    const succeeded = pairs.find((p) => p.state === "succeeded" || p.nominated);
    let pairDesc = "no selected/succeeded candidate-pair yet";
    if (succeeded) {
      const lc = candidates.get(succeeded.localCandidateId);
      const rc = candidates.get(succeeded.remoteCandidateId);
      const relayNote = lc?.candidateType === "relay" || rc?.candidateType === "relay" ? " [TURN RELAY IN USE]" : "";
      pairDesc = `state=${succeeded.state} nominated=${!!succeeded.nominated} local=${lc?.candidateType}/${lc?.protocol} remote=${rc?.candidateType}/${rc?.protocol}${relayNote}`;
    }
    log(`[conn:${label}] pc.connectionState=${pc.connectionState} iceConnectionState=${pc.iceConnectionState} iceGatheringState=${pc.iceGatheringState} signalingState=${pc.signalingState} | selected candidate-pair: ${pairDesc}`);
    document.getElementById("candidatePair").textContent = `pair: ${pairDesc}`;
  } catch (e) {
    log(`[conn:${label}] getStats failed: ${e}`);
  }
}

/** Best-effort local type/address/port parse straight from the SDP candidate string — works for both local (RTCIceCandidate) and remote (plain JSON payload) candidates, so remote candidate type is no longer a blind spot. */
function parseCandidateString(candidateStr) {
  if (!candidateStr) return { type: "?", proto: "?", address: "?", port: "?" };
  const m = /candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/.exec(candidateStr);
  if (!m) return { type: "?", proto: "?", address: "?", port: "?" };
  const [, proto, address, port, type] = m;
  return { type, proto, address, port };
}

async function setupConnection(isOfferer) {
  log(`[conn] step: fetchIceServers (isOfferer=${isOfferer})`);
  const iceServers = await fetchIceServers();
  log(`[conn] step: fetchIceServers done, ${iceServers.length} ICE server entries`);
  pc = new RTCPeerConnection({ iceServers });
  window.__pc = pc; // for console inspection

  // Instrumentation only — every RTCPeerConnection state transition, logged as it happens.
  pc.onconnectionstatechange = () => log(`[conn] pc.connectionState -> ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => log(`[conn] pc.iceConnectionState -> ${pc.iceConnectionState}`);
  pc.onicegatheringstatechange = () => log(`[conn] pc.iceGatheringState -> ${pc.iceGatheringState}`);
  pc.onsignalingstatechange = () => log(`[conn] pc.signalingState -> ${pc.signalingState}`);
  pc.onicecandidateerror = (e) =>
    log(`[conn] ICE candidate ERROR: errorCode=${e.errorCode} errorText=${e.errorText} url=${e.url} address=${e.address ?? "?"} port=${e.port ?? "?"}`);

  // Accumulated for the end-of-gathering summary below — every candidate
  // this side gathers AND every candidate the remote side sends us,
  // each with its parsed type (host/srflx/relay/prflx).
  const gatheredLocalCandidates = [];
  const receivedRemoteCandidates = [];

  control = pc.createDataChannel("control", { negotiated: true, id: 0, ordered: true });
  channels.reliableOrdered = pc.createDataChannel("reliableOrdered", { negotiated: true, id: 1, ordered: true });
  channels.reliableUnordered = pc.createDataChannel("reliableUnordered", { negotiated: true, id: 2, ordered: false });
  channels.partial = pc.createDataChannel("partial", { negotiated: true, id: 3, ordered: false, maxRetransmits: 0 });
  for (const ch of Object.values(channels)) ch.binaryType = "arraybuffer";

  // Instrumentation only — addEventListener (not the onopen/onclose/onerror
  // IDL properties) so this cannot clobber the actual wait-for-open logic
  // further down, which uses the onopen property directly.
  for (const ch of [control, ...Object.values(channels)]) {
    log(`[conn] channel "${ch.label}" created, readyState=${ch.readyState}`);
    ch.addEventListener("open", () => log(`[conn] channel "${ch.label}" -> OPEN`));
    ch.addEventListener("close", () => log(`[conn] channel "${ch.label}" -> CLOSE`));
    ch.addEventListener("error", (e) => log(`[conn] channel "${ch.label}" -> ERROR: ${e.error?.message ?? e}`));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      gatheredLocalCandidates.push({ type: e.candidate.type, proto: e.candidate.protocol, address: e.candidate.address, port: e.candidate.port, relatedAddress: e.candidate.relatedAddress });
      log(`[conn] local ICE candidate gathered: type=${e.candidate.type} proto=${e.candidate.protocol} address=${e.candidate.address}:${e.candidate.port} relatedAddress=${e.candidate.relatedAddress ?? "n/a"}`);
      signaling.send({ type: "relay-ice", payload: e.candidate.toJSON() });
    } else {
      const counts = gatheredLocalCandidates.reduce((acc, c) => ((acc[c.type] = (acc[c.type] || 0) + 1), acc), {});
      log(`[conn] local ICE gathering COMPLETE (null candidate) — gathered ${gatheredLocalCandidates.length} local candidates, by type: ${JSON.stringify(counts)}`);
      if (!counts.relay) log("[conn] *** NO local relay (TURN) candidate was ever gathered ***");
    }
  };
  const remoteCandidateQueue = [];
  let remoteDescSet = false;
  signaling.onMessage((msg) => {
    if (msg.type === "relay-ice") {
      const parsed = parseCandidateString(msg.payload?.candidate);
      receivedRemoteCandidates.push(parsed);
      const counts = receivedRemoteCandidates.reduce((acc, c) => ((acc[c.type] = (acc[c.type] || 0) + 1), acc), {});
      log(`[conn] remote ICE candidate received: type=${parsed.type} proto=${parsed.proto} address=${parsed.address}:${parsed.port} (remoteDescSet=${remoteDescSet}) — remote candidates so far by type: ${JSON.stringify(counts)}`);
      if (remoteDescSet) pc.addIceCandidate(msg.payload).catch((e) => log(`[conn] addIceCandidate FAILED: ${e}`));
      else remoteCandidateQueue.push(msg.payload);
    }
  });

  if (isOfferer) {
    log("[conn] step: createOffer");
    const offer = await pc.createOffer();
    log("[conn] step: setLocalDescription(offer)");
    await pc.setLocalDescription(offer);
    log("[conn] step: send relay-sdp offer");
    signaling.send({ type: "relay-sdp", payload: { type: "offer", sdp: offer.sdp } });
    log("[conn] step: waitFor relay-sdp (expecting answer)");
    const answerMsg = await signaling.waitFor("relay-sdp", 60000);
    log("[conn] step: setRemoteDescription(answer)");
    await pc.setRemoteDescription({ type: "answer", sdp: answerMsg.payload.sdp });
    remoteDescSet = true;
    log(`[conn] step: draining ${remoteCandidateQueue.length} queued remote ICE candidates`);
    for (const c of remoteCandidateQueue.splice(0)) await pc.addIceCandidate(c).catch((e) => log(`[conn] queued addIceCandidate FAILED: ${e}`));
  } else {
    log("[conn] step: waitFor relay-sdp (expecting offer)");
    const offerMsg = await signaling.waitFor("relay-sdp", 60000);
    log("[conn] step: setRemoteDescription(offer)");
    await pc.setRemoteDescription({ type: "offer", sdp: offerMsg.payload.sdp });
    remoteDescSet = true;
    log(`[conn] step: draining ${remoteCandidateQueue.length} queued remote ICE candidates`);
    for (const c of remoteCandidateQueue.splice(0)) await pc.addIceCandidate(c).catch((e) => log(`[conn] queued addIceCandidate FAILED: ${e}`));
    log("[conn] step: createAnswer");
    const answer = await pc.createAnswer();
    log("[conn] step: setLocalDescription(answer)");
    await pc.setLocalDescription(answer);
    log("[conn] step: send relay-sdp answer");
    signaling.send({ type: "relay-sdp", payload: { type: "answer", sdp: answer.sdp } });
  }

  log("[conn] step: waiting for all channels to reach OPEN — polling connectivity every 2s until then");
  const pollTimer = setInterval(() => {
    const states = [control, ...Object.values(channels)].map((ch) => `${ch.label}:${ch.readyState}`).join(", ");
    log(`[conn] still waiting — channel states: ${states}`);
    void logConnectivitySnapshot("waiting-for-channels");
  }, 2000);

  await Promise.all(
    [control, ...Object.values(channels)].map(
      (ch) => new Promise((resolve) => (ch.readyState === "open" ? resolve() : (ch.onopen = resolve)))
    )
  );
  clearInterval(pollTimer);
  log("[conn] step: all channels OPEN — setupConnection complete");
  void logConnectivitySnapshot("connected");
  log("All channels OPEN");
}

async function collectConnectionMetrics() {
  const stats = await pc.getStats();
  const out = { rttMs: null, localType: null, remoteType: null, relayProtocol: null, packetsSent: null, packetsReceived: null, bytesSent: null, bytesReceived: null, sctpState: null };
  const types = new Map();
  let localId, remoteId;
  stats.forEach((r) => {
    if (r.type === "candidate-pair" && (r.state === "succeeded" || r.nominated)) {
      localId = r.localCandidateId;
      remoteId = r.remoteCandidateId;
      if (typeof r.currentRoundTripTime === "number") out.rttMs = Math.round(r.currentRoundTripTime * 1000);
      out.packetsSent = r.packetsSent ?? out.packetsSent;
      out.packetsReceived = r.packetsReceived ?? out.packetsReceived;
      out.bytesSent = r.bytesSent ?? out.bytesSent;
      out.bytesReceived = r.bytesReceived ?? out.bytesReceived;
    }
    if (r.type === "local-candidate" || r.type === "remote-candidate") types.set(r.id, r);
    if (r.type === "transport" && r.dtlsState) out.sctpState = r.dtlsState; // closest standard field; real "sctp-transport" type isn't universally exposed
  });
  if (localId) {
    const lc = types.get(localId);
    out.localType = lc?.candidateType ?? null;
    out.relayProtocol = lc?.relayProtocol ?? (lc?.candidateType === "relay" ? lc?.protocol : null);
  }
  if (remoteId) out.remoteType = types.get(remoteId)?.candidateType ?? null;
  return out;
}

/**
 * Waits until dc.bufferedAmount <= threshold — resolving IMMEDIATELY if
 * that's already true. This check is required, not optional:
 * `bufferedamountlow` only fires on a TRANSITION into <= threshold. If the
 * buffer is already at/below threshold by the time a listener is
 * installed (very reachable over a real higher-RTT TURN-relayed path,
 * where the transition can complete in the gap before we get around to
 * listening for it), that transition already happened and will never
 * happen again — naively awaiting the event with no upfront check hangs
 * forever. Also re-checks immediately AFTER installing the listener, to
 * close the same race in the gap between the initial check and the
 * listener actually being attached.
 */
function waitUntilBufferedAtMost(dc, threshold) {
  dc.bufferedAmountLowThreshold = threshold;
  return new Promise((resolve) => {
    if (dc.bufferedAmount <= threshold) {
      resolve();
      return;
    }
    const settle = () => {
      dc.removeEventListener("bufferedamountlow", settle);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", settle);
    if (dc.bufferedAmount <= threshold) settle();
  });
}

/**
 * Configurable benchmark-only backpressure watermarks (separate from fd9's
 * production transfer pipeline in receiver.ts/sender.ts). The high
 * watermark is capped at a 4 MiB ceiling deliberately kept well under
 * Chromium's actual internal per-channel send-buffer limit — observed in
 * practice, over a real TURN-relayed path, to be reachable well before our
 * own `bufferedAmount` watermark check fires if that check is set too
 * close to it (which is exactly what caused "RTCDataChannel send queue is
 * full": the previous 16 MiB floor left ~zero margin below that ceiling).
 */
const BENCH_HIGH_WATERMARK_CEILING_BYTES = 4 * 1024 * 1024;
const BENCH_HIGH_WATERMARK_FLOOR_BYTES = 256 * 1024;

function benchWatermarks(chunkBytes) {
  const highWatermark = Math.min(
    BENCH_HIGH_WATERMARK_CEILING_BYTES,
    Math.max(BENCH_HIGH_WATERMARK_FLOOR_BYTES, chunkBytes * 4)
  );
  const lowThreshold = Math.max(16 * 1024, Math.floor(highWatermark / 4));
  return { highWatermark, lowThreshold };
}

let controlQueue = [];
let controlWaiters = [];
function control_onMessage(msg) {
  const waiter = controlWaiters.find((w) => w.types.includes(msg.type));
  if (waiter) {
    controlWaiters.splice(controlWaiters.indexOf(waiter), 1);
    waiter.resolve(msg);
  } else {
    controlQueue.push(msg);
  }
}
// Accepts one type or an array of types — waiting on several possible
// types is done as ONE waiter registration, not a Promise.race of several
// separate control_waitFor calls: racing separate registrations leaves the
// LOSING registration still sitting in controlWaiters forever (nothing
// ever removes it), where it then incorrectly intercepts a future
// message of that same type meant for a later, unrelated wait.
function control_waitFor(typeOrTypes, timeoutMs = 120000) {
  const types = Array.isArray(typeOrTypes) ? typeOrTypes : [typeOrTypes];
  const queued = controlQueue.find((m) => types.includes(m.type));
  if (queued) {
    controlQueue.splice(controlQueue.indexOf(queued), 1);
    return Promise.resolve(queued);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for control [${types.join(",")}]`)), timeoutMs);
    controlWaiters.push({ types, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}

async function runOneTestAsSender(test) {
  const dc = channels[test.channel];
  const chunk = new ArrayBuffer(test.chunk);
  const { highWatermark, lowThreshold } = benchWatermarks(test.chunk);
  dc.bufferedAmountLowThreshold = lowThreshold;

  control.send(JSON.stringify({ type: "test-start", label: test.label, channel: test.channel, chunk: test.chunk, totalBytes: totalBytesPerTest }));
  await control_waitFor("test-ready");

  let sent = 0;
  let messages = 0;
  let maxBufferedAmount = 0;
  let bufferedWaitMs = 0;
  const rateSamples = [];
  let lastSampleT = performance.now();
  let lastSampleBytes = 0;
  const sampleInterval = setInterval(() => {
    const now = performance.now();
    const db = sent - lastSampleBytes;
    const dt = (now - lastSampleT) / 1000;
    if (dt > 0) rateSamples.push(db / (1024 * 1024) / dt);
    lastSampleT = now;
    lastSampleBytes = sent;
  }, 200);

  const t0 = performance.now();
  while (sent < totalBytesPerTest) {
    maxBufferedAmount = Math.max(maxBufferedAmount, dc.bufferedAmount);
    if (dc.bufferedAmount > highWatermark) {
      const tWait = performance.now();
      await waitUntilBufferedAtMost(dc, lowThreshold);
      bufferedWaitMs += performance.now() - tWait;
    }
    try {
      dc.send(chunk);
      sent += test.chunk;
      messages++;
    } catch (err) {
      // "send queue is full" is ALWAYS transient backpressure, even if our
      // own bufferedAmount counter currently reads at/below threshold: it
      // means the browser's real internal send buffer (which can lag or
      // differ from the bufferedAmount counter, especially over a
      // higher-latency TURN-relayed path) is at capacity right now, not
      // that the message itself is unsendable. Only a DIFFERENT error
      // (most likely the chunk exceeding this connection's real negotiated
      // SCTP max-message-size) is treated as permanent — and only when
      // bufferedAmount is already at/below threshold, where that would
      // otherwise mean onbufferedamountlow will never fire again and
      // awaiting it would hang forever.
      const message = (err && err.message) || "";
      const isQueueFull = /queue is full/i.test(message);
      log(`send() threw at chunk=${test.chunk}: ${message}${isQueueFull ? " (transient backpressure, retrying)" : ""}`);
      if (!isQueueFull && dc.bufferedAmount <= lowThreshold) {
        clearInterval(sampleInterval);
        throw new Error(`${test.label}: dc.send() failed with bufferedAmount already low (${dc.bufferedAmount} <= ${lowThreshold}) — likely chunk size ${test.chunk} exceeds this connection's max message size (pc.sctp.maxMessageSize=${pc.sctp?.maxMessageSize ?? "unknown"}). Original error: ${message}`);
      }
      const tWait = performance.now();
      await waitUntilBufferedAtMost(dc, lowThreshold);
      bufferedWaitMs += performance.now() - tWait;
    }
  }
  await waitUntilBufferedAtMost(dc, 0);
  const elapsedMs = performance.now() - t0;
  clearInterval(sampleInterval);

  const connMetrics = await collectConnectionMetrics();
  control.send(JSON.stringify({ type: "test-done", sent, messages, elapsedMs, maxBufferedAmount, bufferedWaitMs }));
  const ack = await control_waitFor("test-ack");

  const avgMBs = sent / (1024 * 1024) / (elapsedMs / 1000);
  const peakMBs = rateSamples.length ? Math.max(...rateSamples) : avgMBs;
  const row = {
    label: test.label,
    chunk: test.chunk,
    reliability: test.channel,
    durationMs: Math.round(elapsedMs),
    avgMBs: avgMBs.toFixed(1),
    peakMBs: peakMBs.toFixed(1),
    messagesPerSec: Math.round(messages / (elapsedMs / 1000)),
    totalBytes: sent,
    maxBufferedAmount,
    bufferedWaitMs: Math.round(bufferedWaitMs),
    receiverBytesReceived: ack.bytesReceived,
    receiverMessagesReceived: ack.messagesReceived,
    deliveryRatio: ack.bytesReceived / sent,
    rttMs: connMetrics.rttMs,
    localCandidateType: connMetrics.localType,
    remoteCandidateType: connMetrics.remoteType,
    relayProtocol: connMetrics.relayProtocol,
    packetsSent: connMetrics.packetsSent,
    packetsReceived: connMetrics.packetsReceived,
    cpuUsage: "not available via any standard browser API"
  };
  results.push(row);
  log(`DONE: ${test.label} -> ${avgMBs.toFixed(1)} MB/s avg, ${peakMBs.toFixed(1)} MB/s peak, delivery ${(row.deliveryRatio * 100).toFixed(2)}%`);
  renderResults();
}

async function runAsReceiverLoop() {
  const active = { bytes: 0, messages: 0, running: false };
  for (const ch of Object.values(channels)) {
    ch.onmessage = (ev) => {
      if (!active.running) return;
      active.bytes += ev.data.byteLength;
      active.messages++;
    };
  }
  control.onmessage = (ev) => control_onMessage(JSON.parse(ev.data));

  for (;;) {
    const start = await control_waitFor("test-start", 600000).catch(() => null);
    if (!start) break;
    active.bytes = 0;
    active.messages = 0;
    active.running = true;
    control.send(JSON.stringify({ type: "test-ready" }));
    const outcome = await control_waitFor(["test-done", "test-abort"]);
    active.running = false;
    if (outcome.type === "test-abort") {
      log(`receiver: ${start.label} -> sender aborted this sub-test (likely send() failure), skipping`);
      continue;
    }
    const done = outcome;
    // Grace window for any last in-flight (especially partial-reliability) messages.
    await new Promise((r) => setTimeout(r, 500));
    control.send(JSON.stringify({ type: "test-ack", bytesReceived: active.bytes, messagesReceived: active.messages }));
    log(`receiver: ${start.label} -> received ${(active.bytes / (1024 * 1024)).toFixed(1)} MiB / sent ${(done.sent / (1024 * 1024)).toFixed(1)} MiB`);
  }
  log("Receiver: all tests observed, matrix complete.");
}

function renderResults() {
  const headers = ["Test", "Chunk", "Reliability", "Duration(ms)", "Avg MB/s", "Peak MB/s", "Msgs/s", "Total Bytes", "Max Buffered", "Buffered Wait(ms)", "Delivery %", "RTT(ms)", "Local Type", "Remote Type", "Relay Proto"];
  let html = "<table><tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr>";
  for (const r of results) {
    html += `<tr><td>${r.label}</td><td>${r.chunk}</td><td>${r.reliability}</td><td>${r.durationMs}</td><td>${r.avgMBs}</td><td>${r.peakMBs}</td><td>${r.messagesPerSec}</td><td>${r.totalBytes}</td><td>${r.maxBufferedAmount}</td><td>${r.bufferedWaitMs}</td><td>${(r.deliveryRatio * 100).toFixed(2)}</td><td>${r.rttMs ?? "—"}</td><td>${r.localCandidateType ?? "—"}</td><td>${r.remoteCandidateType ?? "—"}</td><td>${r.relayProtocol ?? "—"}</td></tr>`;
  }
  html += "</table>";
  document.getElementById("resultsTable").innerHTML = html;
  document.getElementById("copyBtn").disabled = results.length === 0;
  console.table(results);
}

function resultsAsMarkdown() {
  let md = "| Test | Chunk | Reliability | Duration(ms) | Avg MB/s | Peak MB/s | Msgs/s | Total Bytes | Max Buffered | Buffered Wait(ms) | Delivery % | RTT(ms) | Local Type | Remote Type | Relay Proto |\n";
  md += "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  for (const r of results) {
    md += `| ${r.label} | ${r.chunk} | ${r.reliability} | ${r.durationMs} | ${r.avgMBs} | ${r.peakMBs} | ${r.messagesPerSec} | ${r.totalBytes} | ${r.maxBufferedAmount} | ${r.bufferedWaitMs} | ${(r.deliveryRatio * 100).toFixed(2)} | ${r.rttMs ?? "—"} | ${r.localCandidateType ?? "—"} | ${r.remoteCandidateType ?? "—"} | ${r.relayProtocol ?? "—"} |\n`;
  }
  return md;
}

document.getElementById("createBtn").onclick = async () => {
  setStatus("connecting signaling...");
  signaling = new SignalingClient(resolveSignalingUrl());
  await signaling.waitOpen();
  signaling.send({ type: "create-room" });
  const created = await signaling.waitFor("room-created");
  document.getElementById("roomCodeDisplay").textContent = `Room code: ${created.code}`;
  setStatus("waiting for peer...");
  await signaling.waitFor("peer-joined", 300000);
  role = "sender";
  setStatus("setting up connection...");
  await setupConnection(true);
  setStatus("connected — ready");
  document.getElementById("startBtn").disabled = false;
};

document.getElementById("joinBtn").onclick = async () => {
  const code = document.getElementById("codeInput").value.trim().toUpperCase();
  setStatus("connecting signaling...");
  signaling = new SignalingClient(resolveSignalingUrl());
  await signaling.waitOpen();
  signaling.send({ type: "join-room", code });
  await signaling.waitFor("joined");
  role = "receiver";
  setStatus("setting up connection...");
  await setupConnection(false);
  setStatus("connected — receiving (watch the log)");
  runAsReceiverLoop();
};

document.getElementById("startBtn").onclick = async () => {
  totalBytesPerTest = Number(document.getElementById("totalMiB").value) * 1024 * 1024;
  document.getElementById("startBtn").disabled = true;
  control.onmessage = (ev) => control_onMessage(JSON.parse(ev.data));
  log(`pc.sctp.maxMessageSize = ${pc.sctp?.maxMessageSize ?? "unknown (not exposed by this browser)"}`);
  for (const test of TEST_PLAN) {
    log(`\n=== Starting: ${test.label} (${(totalBytesPerTest / (1024 * 1024)).toFixed(0)} MiB) ===`);
    try {
      await runOneTestAsSender(test);
    } catch (err) {
      log(`SKIPPED (failed): ${test.label} -> ${err && err.message}`);
      control.send(JSON.stringify({ type: "test-abort" }));
    }
  }
  log("\n=== ALL TESTS COMPLETE ===");
  log(resultsAsMarkdown());
};

document.getElementById("copyBtn").onclick = async () => {
  await navigator.clipboard.writeText(resultsAsMarkdown());
  log("Copied results as Markdown to clipboard.");
};
