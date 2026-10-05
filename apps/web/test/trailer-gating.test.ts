import { describe, expect, it } from "vitest";
import { FakeControlChannel, FakeDataChannel } from "../src/lib/transfer/channels.js";
import { SenderEngine } from "../src/lib/transfer/sender.js";
import type { SendableFile } from "../src/lib/transfer/types.js";

/**
 * Regression test for the N=2 multi-lane integrity bug: sendOneFile used to
 * gate file-trailer on pool.drainAll() alone (every lane's LOCAL
 * bufferedAmount reaching 0). Per the WebRTC spec, bufferedAmount==0 only
 * means "handed to the network" — not "the peer has it" — so that gate was
 * satisfiable before the receiver had actually received everything,
 * letting the trailer race ahead of in-flight data. Proven directly in a
 * real 2-PC Azure-TURN run: confirmedBytes was measured at 37% of file.size
 * the instant drainAll() had already resolved.
 *
 * This test reproduces exactly that gap with FakeDataChannel's autoFlush
 * mode (bufferedAmount reaches 0 on the very next microtask, like a fast
 * loopback network — no real RTT to mask the race) while deliberately
 * driving the control channel by hand instead of using a real
 * ReceiverEngine, so NO chunk-ack is ever sent automatically. If the
 * trailer gate were still drainAll()-only, it would fire here despite the
 * receiver never having confirmed a single byte.
 */
describe("sender withholds file-trailer until the receiver confirms full delivery", () => {
  it("does not send file-trailer while local buffers are drained but confirmedBytes is still behind file.size", async () => {
    const controlA = new FakeControlChannel();
    const controlB = new FakeControlChannel();
    controlA.link(controlB);
    controlB.link(controlA);
    const dataA = new FakeDataChannel(true); // autoFlush: bufferedAmount hits 0 almost immediately
    const dataB = new FakeDataChannel(true);
    dataA.link(dataB);
    dataB.link(dataA);

    const original = new Uint8Array(200).fill(9);
    const file: SendableFile = {
      fileIndex: 0,
      name: "gate.bin",
      size: original.byteLength,
      mimeType: "application/octet-stream",
      source: new Blob([original])
    };
    const sender = new SenderEngine(controlA, [dataA], [file], 16);

    const receivedTypes: string[] = [];
    controlB.onMessage((json) => {
      receivedTypes.push(JSON.parse(json).type);
    });

    await sender.offer();
    controlB.send(JSON.stringify({ type: "file-offer-response", accepted: [0], rejected: [] }));

    // Long enough for every chunk to be sent AND auto-flushed (bufferedAmount
    // back to 0 on every lane) many times over, with no real network RTT to
    // hide behind. If the old drainAll()-only gate were still in place, the
    // trailer would already have been sent by now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receivedTypes).not.toContain("file-trailer");

    // Now supply the confirmation a real ReceiverEngine's final chunk-ack
    // always sends unconditionally — this is what should unblock the trailer.
    controlB.send(JSON.stringify({ type: "chunk-ack", fileIndex: 0, confirmedBytes: original.byteLength }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedTypes).toContain("file-trailer");

    // Let sendOneFile finish cleanly instead of leaving it awaiting forever.
    controlB.send(JSON.stringify({ type: "file-complete", fileIndex: 0, ok: true, sha256Hex: "irrelevant-for-this-test" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
