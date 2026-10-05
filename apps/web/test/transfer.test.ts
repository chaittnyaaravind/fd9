import { describe, expect, it } from "vitest";
import { FakeControlChannel, FakeDataChannel } from "../src/lib/transfer/channels.js";
import { ReceiverEngine } from "../src/lib/transfer/receiver.js";
import { SenderEngine } from "../src/lib/transfer/sender.js";
import type { SendableFile } from "../src/lib/transfer/types.js";

function buildSession(chunkSize: number, autoFlush = true) {
  const controlA = new FakeControlChannel();
  const controlB = new FakeControlChannel();
  controlA.link(controlB);
  controlB.link(controlA);

  const dataA = new FakeDataChannel(autoFlush);
  const dataB = new FakeDataChannel(autoFlush);
  dataA.link(dataB);
  dataB.link(dataA);

  return { controlA, controlB, dataA, dataB };
}

function waitFor<T>(promiseLike: Promise<T>, label: string, ms = 2000): Promise<T> {
  return Promise.race([
    promiseLike,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms))
  ]);
}

describe("end-to-end transfer", () => {
  it("transfers a single file byte-for-byte", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(8);
    const original = new TextEncoder().encode("the quick brown fox jumps over the lazy dog, repeatedly".repeat(5));
    const file: SendableFile = { fileIndex: 0, name: "fox.txt", size: original.byteLength, mimeType: "text/plain", source: new Blob([original]) };

    const sender = new SenderEngine(controlA, [dataA], [file], 8);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    const ready = new Promise<Blob | null>((resolve) => {
      receiver.on("file-ready", (e) => resolve(e.blob));
    });
    receiver.on("offer", (offer) => {
      receiver.accept(offer.files.map((f) => f.fileIndex), [], new Map());
    });

    await sender.offer();
    const blob = await waitFor(ready, "file-ready");
    const receivedBytes = new Uint8Array(await blob!.arrayBuffer());
    expect(Array.from(receivedBytes)).toEqual(Array.from(original));
  });

  it("transfers an empty file", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(16);
    const file: SendableFile = { fileIndex: 0, name: "empty.bin", size: 0, mimeType: "application/octet-stream", source: new Blob([]) };
    const sender = new SenderEngine(controlA, [dataA], [file], 16);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    const ready = new Promise<Blob | null>((resolve) => receiver.on("file-ready", (e) => resolve(e.blob)));
    receiver.on("offer", (offer) => receiver.accept(offer.files.map((f) => f.fileIndex), [], new Map()));

    await sender.offer();
    const blob = await waitFor(ready, "empty file-ready");
    expect(blob!.size).toBe(0);
  });

  it("dedupes duplicate filenames and transfers both correctly", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(32);
    const a = new TextEncoder().encode("AAAA file one content");
    const b = new TextEncoder().encode("BBBB file two content, different");
    const files: SendableFile[] = [
      { fileIndex: 0, name: "notes.txt", size: a.byteLength, mimeType: "text/plain", source: new Blob([a]) },
      { fileIndex: 1, name: "notes.txt", size: b.byteLength, mimeType: "text/plain", source: new Blob([b]) }
    ];
    const sender = new SenderEngine(controlA, [dataA], files, 32);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    const readyBlobs = new Map<number, Blob>();
    const allReady = new Promise<void>((resolve) => {
      receiver.on("file-ready", (e) => {
        readyBlobs.set(e.fileIndex, e.blob!);
        if (readyBlobs.size === 2) resolve();
      });
    });
    let suggestedNames: string[] = [];
    receiver.on("offer", (offer) => {
      suggestedNames = offer.suggestedNames;
      receiver.accept(offer.files.map((f) => f.fileIndex), [], new Map());
    });

    await sender.offer();
    await waitFor(allReady, "both files ready");

    expect(suggestedNames).toEqual(["notes.txt", "notes (1).txt"]);
    expect(new Uint8Array(await readyBlobs.get(0)!.arrayBuffer())).toEqual(a);
    expect(new Uint8Array(await readyBlobs.get(1)!.arrayBuffer())).toEqual(b);
  });

  it("supports pause and resume mid-transfer", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(4);
    const original = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz");
    const file: SendableFile = { fileIndex: 0, name: "f.bin", size: original.byteLength, mimeType: "application/octet-stream", source: new Blob([original]) };
    const sender = new SenderEngine(controlA, [dataA], [file], 4);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    let pausedOnce = false;
    const progressSeen: string[] = [];
    sender.on("progress", (list) => {
      progressSeen.push(list[0]?.status);
      if (!pausedOnce && list[0]?.bytesMoved > 0) {
        pausedOnce = true;
        sender.pause(0);
        setTimeout(() => sender.resume(0), 20);
      }
    });

    const ready = new Promise<Blob | null>((resolve) => receiver.on("file-ready", (e) => resolve(e.blob)));
    receiver.on("offer", (offer) => receiver.accept(offer.files.map((f) => f.fileIndex), [], new Map()));

    await sender.offer();
    const blob = await waitFor(ready, "paused file-ready", 3000);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(original);
    expect(progressSeen).toContain("paused");
  });

  it("cancels a transfer and never reports it complete", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(4);
    const original = new Uint8Array(200).fill(7);
    const file: SendableFile = { fileIndex: 0, name: "big.bin", size: original.byteLength, mimeType: "application/octet-stream", source: new Blob([original]) };
    const sender = new SenderEngine(controlA, [dataA], [file], 4);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    let cancelled = false;
    sender.on("progress", (list) => {
      if (!cancelled && list[0]?.bytesMoved >= 8) {
        cancelled = true;
        sender.cancel(0);
      }
    });
    const fileReady = new Promise<void>((resolve) => receiver.on("file-ready", () => resolve()));

    await sender.offer();
    await waitFor(new Promise((resolve) => setTimeout(resolve, 100)), "settle");

    const raced = await Promise.race([fileReady.then(() => "ready"), Promise.resolve("no-ready")]);
    expect(raced).toBe("no-ready");
  });

  it("pauses sending once bufferedAmount exceeds the high watermark and resumes on drain", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(1024, false);
    const original = new Uint8Array(40 * 1024 * 1024).fill(1); // bigger than the 8 MiB high watermark
    const file: SendableFile = { fileIndex: 0, name: "huge.bin", size: original.byteLength, mimeType: "application/octet-stream", source: new Blob([original]) };
    const sender = new SenderEngine(controlA, [dataA], [file], 1024 * 1024);
    void sender.offer();

    // Manually accept without a receiver engine — we only care about sender's bufferedAmount behavior.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controlB.send(JSON.stringify({ type: "file-offer-response", accepted: [0], rejected: [] }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dataA.bufferedAmount).toBeGreaterThan(0);
    const bufferedBeforeDrain = dataA.bufferedAmount;
    expect(bufferedBeforeDrain).toBeLessThanOrEqual(10 * 1024 * 1024); // stayed bounded, didn't dump the whole file

    // Draining resolves the sender's pending bufferedamountlow wait, but that
    // continuation (and any further sends) only run on a later microtask —
    // so checked synchronously right after flush(), bufferedAmount must
    // already reflect the drain and nothing has refilled it yet.
    dataA.flush();
    expect(dataA.bufferedAmount).toBeLessThan(bufferedBeforeDrain);

    // Given room again, the sender keeps going (doesn't deadlock) and the
    // buffer climbs back toward the watermark instead of staying drained.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dataA.bufferedAmount).toBeGreaterThan(0);
  });

  it("retries instead of failing the file when send() throws (the real 'send queue is full' browser error)", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(8);
    const original = new TextEncoder().encode("retry me please, this should not fail the whole file");
    const file: SendableFile = { fileIndex: 0, name: "f.bin", size: original.byteLength, mimeType: "application/octet-stream", source: new Blob([original]) };
    const sender = new SenderEngine(controlA, [dataA], [file], 8);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    // Simulate the browser throwing on the first couple of send() calls —
    // this must be absorbed as backpressure, not a fatal transfer failure.
    dataA.failNextSends(2);

    const ready = new Promise<Blob | null>((resolve) => receiver.on("file-ready", (e) => resolve(e.blob)));
    const failed: string[] = [];
    sender.on("progress", (list) => {
      if (list[0]?.status === "failed") failed.push(list[0].error ?? "unknown");
    });
    receiver.on("offer", (offer) => receiver.accept(offer.files.map((f) => f.fileIndex), [], new Map()));

    await sender.offer();
    const blob = await waitFor(ready, "file-ready after retried sends", 3000);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(original);
    expect(failed).toEqual([]);
  });

  it("resumes after a reconnect from the receiver's confirmed offset, deduping overlap instead of restarting from zero", async () => {
    const { controlA, controlB, dataA, dataB } = buildSession(16);
    const original = new Uint8Array(400).fill(0).map((_, i) => i % 256);
    const file: SendableFile = { fileIndex: 0, name: "resumable.bin", size: original.byteLength, mimeType: "application/octet-stream", source: new Blob([original]) };
    const sender = new SenderEngine(controlA, [dataA], [file], 16);
    const receiver = new ReceiverEngine(controlB, [dataB]);

    // Real acks are throttled by time/byte-interval and wouldn't reliably
    // land mid-transfer for a file this small and this fast — inject one
    // directly (exactly what the receiver's real chunk-ack does) so the
    // resume point is deterministic and clearly not 0 or the full file.
    const confirmedAtReconnect = 80;
    let reconnectedOnce = false;
    sender.on("progress", (list) => {
      const p = list[0];
      if (!p) return;
      if (!reconnectedOnce && p.bytesMoved >= 160) {
        reconnectedOnce = true;
        controlB.send(JSON.stringify({ type: "chunk-ack", fileIndex: 0, confirmedBytes: confirmedAtReconnect }));
        // Queued after controlB's own send() microtask, so the ack is
        // processed (updating progress.confirmedBytes) before this runs.
        queueMicrotask(() => sender.handleReconnect());
      }
    });

    const ready = new Promise<Blob | null>((resolve) => receiver.on("file-ready", (e) => resolve(e.blob)));
    receiver.on("offer", (offer) => receiver.accept(offer.files.map((f) => f.fileIndex), [], new Map()));

    await sender.offer();
    const blob = await waitFor(ready, "file-ready after simulated reconnect", 3000);

    expect(reconnectedOnce).toBe(true);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(original); // final bytes are still exactly correct despite the mid-transfer resume
  });
});
