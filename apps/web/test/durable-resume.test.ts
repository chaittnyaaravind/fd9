import { createHash } from "node:crypto";
import { decodeChunkFrame } from "@fd9/protocol";
import { describe, expect, it } from "vitest";
import { FakeControlChannel, FakeDataChannel } from "../src/lib/transfer/channels.js";
import { SenderEngine } from "../src/lib/transfer/sender.js";
import type { SendableFile } from "../src/lib/transfer/types.js";

/**
 * Tests the SENDER's half of durable resume (Phase 4 of the throughput
 * audit) directly against the wire protocol, bypassing ReceiverEngine
 * entirely — the receiver's half (matching a persisted record, reopening
 * via reopenOpfsSink) needs real OPFS/IndexedDB, unavailable in Node. This
 * proves the two things that actually matter for correctness:
 *   1. Bytes before the requested resume offset are never re-sent at all.
 *   2. The final whole-file SHA-256 (sent in file-trailer) is still
 *      correct, despite the sender only ever transmitting the suffix —
 *      i.e. the catch-up hashing pass in sendOneFile actually works.
 */
describe("durable resume (sender side: honoring file-offer-response's resumeFrom)", () => {
  it("skips re-sending bytes before the resume offset while still producing the correct whole-file hash", async () => {
    const controlA = new FakeControlChannel();
    const controlB = new FakeControlChannel();
    controlA.link(controlB);
    controlB.link(controlA);
    const dataA = new FakeDataChannel(true);
    const dataB = new FakeDataChannel(true);
    dataA.link(dataB);
    dataB.link(dataA);

    const chunkSize = 16;
    const original = new Uint8Array(400).fill(0).map((_, i) => i % 256);
    const expectedWholeFileHash = createHash("sha256").update(original).digest("hex");
    const resumeOffset = 240; // receiver claims to already durably have the first 240 bytes

    const file: SendableFile = {
      fileIndex: 0,
      name: "resumable.bin",
      size: original.byteLength,
      mimeType: "application/octet-stream",
      source: new Blob([original])
    };
    const sender = new SenderEngine(controlA, [dataA], [file], chunkSize);

    const receivedFrames: { byteOffset: number; length: number }[] = [];
    dataB.onMessage((buffer) => {
      const { byteOffset, payload } = decodeChunkFrame(buffer);
      receivedFrames.push({ byteOffset, length: payload.byteLength });
    });

    let trailerHash: string | null = null;
    controlB.onMessage((json) => {
      const msg = JSON.parse(json);
      if (msg.type === "file-trailer") trailerHash = msg.sha256Hex;
      if (msg.type === "transfer-start" && msg.fileIndex === 0) {
        expect(msg.resumeFromOffset).toBe(resumeOffset);
      }
    });

    await sender.offer();
    // Act as a receiver that matched a persisted durable-resume record for
    // this file and is asking the sender to resume from byte 240 — exactly
    // what ReceiverEngine.accept() would send after a real OPFS match.
    controlB.send(JSON.stringify({ type: "file-offer-response", accepted: [0], rejected: [], resumeFrom: [{ fileIndex: 0, offset: resumeOffset }] }));
    // Drain the control message's transfer-start + every data-channel send + the eventual trailer.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The sender now waits for the receiver's own confirmedBytes to reach
    // the full file size before it will send the trailer (see the N=2
    // integrity fix in sender.ts) — a real ReceiverEngine always sends this
    // unconditionally on its final chunk, so supply the equivalent here.
    controlB.send(JSON.stringify({ type: "chunk-ack", fileIndex: 0, confirmedBytes: original.byteLength }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The sender waits for a file-complete ack before finishing sendOneFile — supply it so the suite doesn't hang on an unawaited promise.
    controlB.send(JSON.stringify({ type: "file-complete", fileIndex: 0, ok: true, sha256Hex: expectedWholeFileHash }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedFrames.length).toBeGreaterThan(0);
    for (const f of receivedFrames) {
      expect(f.byteOffset, `frame at offset ${f.byteOffset} is before the requested resume point ${resumeOffset}`).toBeGreaterThanOrEqual(resumeOffset);
    }
    const totalSentBytes = receivedFrames.reduce((sum, f) => sum + f.length, 0);
    expect(totalSentBytes).toBe(original.byteLength - resumeOffset);
    expect(trailerHash).toBe(expectedWholeFileHash);
  });
});
