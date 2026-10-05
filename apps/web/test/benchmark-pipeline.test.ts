import { describe, expect, it } from "vitest";
import { FakeControlChannel, FakeDataChannel } from "../src/lib/transfer/channels.js";
import { SyntheticChunkSource } from "../src/lib/transfer/benchmarkSource.js";
import { ReceiverEngine, type ReceiverPipelineStats } from "../src/lib/transfer/receiver.js";
import { SenderEngine, type SenderPipelineStats } from "../src/lib/transfer/sender.js";
import { createDiscardSink } from "../src/lib/transfer/sinks.js";
import type { SendableFile } from "../src/lib/transfer/types.js";

function waitFor<T>(promiseLike: Promise<T>, label: string, ms = 60_000): Promise<T> {
  return Promise.race([
    promiseLike,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms))
  ]);
}

function fmt(ms: number, bytes: number): string {
  const mbps = bytes / (1024 * 1024) / (ms / 1000);
  return `${mbps.toFixed(1)} MB/s`;
}

/**
 * Phase-0 throughput audit, part 1 of 2: isolates the pure-JS pipeline cost
 * (framing, decode, hashing, UI-event overhead) from BOTH real disk I/O
 * (SyntheticChunkSource: zero real reads) AND real network/storage
 * (FakeDataChannel: instant loopback; createDiscardSink: no real write).
 * What's left after removing those three variables is exactly stages
 * B (sender JS), D (receiver JS), F (UI overhead), plus hashing — the
 * "assume nothing" breakdown the audit asked for, for the part of the
 * pipeline a real browser isn't needed to measure.
 *
 * Real network throughput (C) and real storage write throughput (E) need
 * an actual browser (RTCDataChannel, IndexedDB/OPFS/FSA) — see the
 * Playwright benchmark spec for those, run against real sizes (256MB-4GB).
 * This Node-level benchmark runs smaller (64 MiB) so it stays fast enough
 * to run on every CI pass, not just on demand.
 */
describe("pipeline benchmark (Phase 0 throughput audit — JS-pipeline-only, no real network/disk/storage)", () => {
  it("reports per-stage timing for a 64 MiB synthetic transfer", async () => {
    const sizeBytes = 64 * 1024 * 1024;
    const chunkSize = 256 * 1024; // matches MAX_CHUNK_SIZE — the real production ceiling

    const controlA = new FakeControlChannel();
    const controlB = new FakeControlChannel();
    controlA.link(controlB);
    controlB.link(controlA);
    const dataA = new FakeDataChannel(true);
    const dataB = new FakeDataChannel(true);
    dataA.link(dataB);
    dataB.link(dataA);

    const file: SendableFile = {
      fileIndex: 0,
      name: "benchmark.bin",
      size: sizeBytes,
      mimeType: "application/octet-stream",
      source: new SyntheticChunkSource(sizeBytes)
    };

    const sender = new SenderEngine(controlA, [dataA], [file], chunkSize);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    let finalSenderStats: SenderPipelineStats | null = null;
    let finalReceiverStats: ReceiverPipelineStats | null = null;
    sender.on("pipeline-stats", (s) => (finalSenderStats = s));
    receiver.on("pipeline-stats", (s) => (finalReceiverStats = s));
    receiver.on("offer", (offer) => {
      receiver.accept(
        offer.files.map((f) => f.fileIndex),
        [],
        new Map([[0, createDiscardSink()]])
      );
    });

    const t0 = performance.now();
    const ready = new Promise<void>((resolve) => receiver.on("file-ready", () => resolve()));
    await sender.offer();
    await waitFor(ready, "benchmark file-ready");
    const wallMs = performance.now() - t0;

    expect(finalSenderStats, "sender never emitted pipeline-stats").not.toBeNull();
    expect(finalReceiverStats, "receiver never emitted pipeline-stats").not.toBeNull();
    const s = finalSenderStats!;
    const r = finalReceiverStats!;

    console.log(`
=== PIPELINE BENCHMARK (${(sizeBytes / (1024 * 1024)).toFixed(0)} MiB synthetic, FakeDataChannel loopback, DiscardSink) ===
wall clock: ${wallMs.toFixed(0)} ms (${fmt(wallMs, sizeBytes)} end-to-end)

SENDER
  stage A (source read):         ${s.readMs.toFixed(1)} ms  (expect ~0 — SyntheticChunkSource has no real I/O)
  backpressure wait (network):   ${s.backpressureWaitMs.toFixed(1)} ms
  stage B (encode + send call):  ${s.sendCallMs.toFixed(1)} ms  -> ${fmt(s.sendCallMs, sizeBytes)}
  hashing:                       ${s.hashMs.toFixed(1)} ms  -> ${fmt(s.hashMs, sizeBytes)}
  stage F (UI/progress emit):    ${s.uiMs.toFixed(1)} ms

RECEIVER
  stage D (decode/bookkeeping):  ${r.decodeMs.toFixed(1)} ms  -> ${fmt(r.decodeMs, sizeBytes)}
  stage E (storage write):       ${r.writeMs.toFixed(1)} ms  (expect ~0 — DiscardSink does no real write)
  hashing:                       ${r.hashMs.toFixed(1)} ms  -> ${fmt(r.hashMs, sizeBytes)}
  stage F (UI/progress emit):    ${r.uiMs.toFixed(1)} ms
`);

    // Sanity, not a performance assertion yet (Phase 1/2 are where fixes
    // land and get re-measured against these same numbers) — just prove
    // the instrumentation itself is coherent: the two near-zero-cost stages
    // (synthetic read, discard write) are clearly smaller than the two real
    // CPU-bound stages (hashing), not an absolute ms threshold that's prone
    // to CI-machine variance/JIT warmup noise.
    expect(s.readMs).toBeLessThan(s.hashMs);
    expect(r.writeMs).toBeLessThan(r.hashMs);
    expect(s.bytesSent).toBe(sizeBytes);
  });
});
