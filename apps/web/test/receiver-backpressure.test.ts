import { describe, expect, it } from "vitest";
import { FakeControlChannel, FakeDataChannel } from "../src/lib/transfer/channels.js";
import { ReceiverEngine, type ReceiveDiagnostics } from "../src/lib/transfer/receiver.js";
import { SenderEngine } from "../src/lib/transfer/sender.js";
import type { FileSink } from "../src/lib/transfer/sinks.js";
import type { SendableFile } from "../src/lib/transfer/types.js";

function waitFor<T>(promiseLike: Promise<T>, label: string, ms = 5000): Promise<T> {
  return Promise.race([
    promiseLike,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms))
  ]);
}

/**
 * A FileSink whose write() takes real wall-clock time (via setTimeout, not
 * just a microtask) — standing in for a real IndexedDB transaction commit,
 * which is exactly what createIndexedDbSink's write() does in a real
 * browser. The point: the data channel keeps delivering onmessage events on
 * microtasks regardless of how slow this is, so if nothing throttles the
 * SENDER, arrived-but-unwritten bytes would pile up without bound while
 * each write is pending.
 */
function createSlowSink(writeDelayMs: number): FileSink & { writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  return {
    writes,
    async write(chunk) {
      await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
      writes.push(chunk.slice());
    },
    async close() {},
    async abort() {}
  };
}

describe("receiver storage backpressure", () => {
  it("keeps in-flight (received-but-unwritten) bytes bounded and still completes correctly against a slow sink", async () => {
    const controlA = new FakeControlChannel();
    const controlB = new FakeControlChannel();
    controlA.link(controlB);
    controlB.link(controlA);
    const dataA = new FakeDataChannel(true);
    const dataB = new FakeDataChannel(true);
    dataA.link(dataB);
    dataB.link(dataA);

    const chunkSize = 1024;
    const highWatermark = 8 * 1024; // deliberately small so the test exercises several pause/resume cycles quickly
    const lowWatermark = 2 * 1024;
    const writeDelayMs = 4;
    const originalSize = 100 * 1024; // ~100 chunks — many multiples of the high watermark

    const original = new Uint8Array(originalSize);
    for (let i = 0; i < originalSize; i++) original[i] = i % 256;
    const file: SendableFile = {
      fileIndex: 0,
      name: "slow.bin",
      size: original.byteLength,
      mimeType: "application/octet-stream",
      source: new Blob([original])
    };

    const sender = new SenderEngine(controlA, [dataA], [file], chunkSize);
    const receiver = new ReceiverEngine(controlB, [dataB], highWatermark, lowWatermark);

    const slowSink = createSlowSink(writeDelayMs);
    const diagnosticsSeen: ReceiveDiagnostics[] = [];
    receiver.on("receive-diagnostics", (d) => diagnosticsSeen.push(d));
    receiver.on("offer", (offer) => {
      receiver.accept(
        offer.files.map((f) => f.fileIndex),
        [],
        new Map([[0, slowSink]])
      );
    });

    const senderFailed: string[] = [];
    sender.on("progress", (list) => {
      if (list[0]?.status === "failed") senderFailed.push(list[0].error ?? "unknown");
    });

    const ready = new Promise<void>((resolve) => receiver.on("file-ready", () => resolve()));

    await sender.offer();
    await waitFor(ready, "slow-sink file-ready", 15_000);

    expect(senderFailed).toEqual([]);

    // The actual bug this guards against: an unbounded receive queue. With
    // the fix, inFlightBytes must never run away — it should stay within a
    // small, bounded overshoot of the high watermark (a few chunks' worth,
    // for whatever was already in flight the instant the threshold was
    // crossed), not grow proportionally to the whole file.
    const maxInFlight = Math.max(...diagnosticsSeen.map((d) => d.inFlightBytes));
    expect(maxInFlight).toBeLessThan(highWatermark + 8 * chunkSize);

    // Backpressure must have actually engaged (proves the watermark logic
    // fired at all, not just that it happened to never be needed) and
    // released again at least once.
    const sawBackpressureEngage = diagnosticsSeen.some((d) => d.backpressureActive);
    const sawBackpressureRelease = diagnosticsSeen.some((d, i) => d.backpressureActive === false && i > 0 && diagnosticsSeen[i - 1].backpressureActive === true);
    expect(sawBackpressureEngage).toBe(true);
    expect(sawBackpressureRelease).toBe(true);

    // And despite all that pausing/resuming, the file arrived byte-for-byte.
    const combined = new Uint8Array(originalSize);
    let offset = 0;
    for (const w of slowSink.writes) {
      combined.set(w, offset);
      offset += w.byteLength;
    }
    expect(offset).toBe(originalSize);
    expect(Array.from(combined)).toEqual(Array.from(original));
  });
});
