import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ControlChannel, DataChannel } from "../src/lib/transfer/channels.js";
import { FakeDataChannel } from "../src/lib/transfer/channels.js";
import { encodeChunkFrame } from "@fd9/protocol";
import { ReceiverEngine } from "../src/lib/transfer/receiver.js";
import { createMemorySink, type FileSink } from "../src/lib/transfer/sinks.js";
import { AdaptiveLaneController, TransportPool } from "../src/lib/transfer/transportPool.js";

/** Waits for a full macrotask turn — guarantees every CURRENTLY-queued microtask (including deeply chained .then/.catch/.finally reactions) has drained, regardless of how many hops the chain has. More robust than guessing a fixed number of `await Promise.resolve()` calls. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitFor<T>(promiseLike: Promise<T>, label: string, ms = 2000): Promise<T> {
  return Promise.race([
    promiseLike,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms))
  ]);
}

/**
 * Minimal deterministic DataChannel stub: `deliver()` invokes the stored
 * handler synchronously, under full test control — no microtask/flush
 * timing to fight, unlike FakeDataChannel. Used only to prove the
 * RECEIVER's reorder-buffer logic handles genuinely out-of-order arrival
 * correctly; sending isn't exercised (sender-side concurrency is already
 * covered by the real multi-lane send loop running through the existing
 * single-lane-equivalent path in transfer.test.ts).
 */
function makeStubLane(): DataChannel & { deliver: (buffer: ArrayBuffer) => void } {
  let handler: ((buffer: ArrayBuffer) => void) | null = null;
  return {
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: () => {},
    onBufferedAmountLow: () => {},
    onMessage: (h) => {
      handler = h;
    },
    deliver: (buffer) => handler?.(buffer)
  };
}

function makeStubControl(): ControlChannel & { deliver: (msg: object) => void; lastSent: () => unknown } {
  let handler: ((json: string) => void) | null = null;
  let last: unknown = null;
  return {
    send: (json) => {
      last = JSON.parse(json);
    },
    onMessage: (h) => {
      handler = h;
    },
    deliver(msg: object) {
      handler?.(JSON.stringify(msg));
    },
    lastSent: () => last
  };
}

describe("multi-lane receive: out-of-order reassembly", () => {
  it("buffers out-of-order chunks from independent lanes and drains them in offset order, byte-for-byte and hash-verified", async () => {
    const control = makeStubControl();
    const laneA = makeStubLane();
    const laneB = makeStubLane();
    const laneC = makeStubLane();

    const receiver = new ReceiverEngine(control, [laneA, laneB, laneC]);
    const baseSink = createMemorySink("text/plain", 10 * 1024 * 1024);
    let writeCount = 0;
    // Wraps the real memory sink so the test can observe exactly when
    // sink.write() actually fires — proves buffering vs. draining directly,
    // without depending on the (intentionally throttled) diagnostics event.
    const sink: FileSink & { toBlobAsync: () => Promise<Blob> } = {
      write: async (chunk) => {
        writeCount++;
        await baseSink.write(chunk);
      },
      close: () => baseSink.close(),
      abort: (reason) => baseSink.abort(reason),
      toBlobAsync: () => baseSink.toBlobAsync()
    };

    const fileIndex = 0;
    const chunkSize = 16;
    const chunk0 = new TextEncoder().encode("AAAAAAAAAAAAAAAA"); // offset 0..16
    const chunk1 = new TextEncoder().encode("BBBBBBBBBBBBBBBB"); // offset 16..32
    const chunk2 = new TextEncoder().encode("CCCCCCCCCCCCCCCC"); // offset 32..48
    const fullBytes = new Uint8Array([...chunk0, ...chunk1, ...chunk2]);
    const sha256Hex = createHash("sha256").update(fullBytes).digest("hex");

    control.deliver({ type: "file-offer", files: [{ fileIndex, name: "f.txt", size: fullBytes.byteLength, mimeType: "text/plain" }] });
    await receiver.accept([fileIndex], [], new Map([[fileIndex, sink]]));
    control.deliver({ type: "transfer-start", fileIndex, chunkSize, resumeFromOffset: 0 });

    // Deliver OUT OF ORDER, from three independent "lanes": last chunk
    // first, then the middle one, then the first one — nothing can be
    // written until the frontier chunk (offset 0) finally arrives.
    laneC.deliver(encodeChunkFrame(fileIndex, 32, chunk2));
    laneB.deliver(encodeChunkFrame(fileIndex, 16, chunk1));

    // ingestAndDrain is queued onto chunkQueue (a microtask continuation,
    // not synchronous) — flush the microtask queue once before asserting
    // nothing was written yet, so this isn't racing the queue itself.
    await Promise.resolve();
    await Promise.resolve();
    expect(writeCount).toBe(0);

    const ready = new Promise<{ blob: Blob | null }>((resolve) => {
      receiver.on("file-ready", (r) => resolve(r));
    });

    // Now deliver the frontier chunk — both buffered chunks must cascade
    // through the SAME write/hash/ack path in the correct offset order.
    laneA.deliver(encodeChunkFrame(fileIndex, 0, chunk0));
    control.deliver({ type: "file-trailer", fileIndex, sha256Hex });

    const { blob } = await waitFor(ready, "file-ready");
    expect(writeCount).toBe(3); // all three chunks eventually written, in order
    expect(blob).not.toBeNull();
    const received = new Uint8Array(await blob!.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(fullBytes));
  });
});

describe("AdaptiveLaneController: grow-until-plateau", () => {
  it("grows active lane count while throughput improves, then stops once it plateaus", () => {
    const lanes = Array.from({ length: 4 }, () => new FakeDataChannel(true));
    const pool = new TransportPool(lanes, 100_000_000, 10_000_000, 1);
    const controller = new AdaptiveLaneController(pool, 4);

    // Every send goes through pool.acquireLane() (the real TransportLane
    // wrapper, whose counter the controller actually samples) rather than
    // the raw FakeDataChannel directly — which lane physically receives it
    // doesn't matter for these assertions, only the AGGREGATE across
    // active lanes that sampleActiveThroughputBytes() computes.

    // Window 1: establishes the baseline — first tick never grows (nothing to compare against yet).
    pool.acquireLane()!.send(new ArrayBuffer(1_000_000));
    controller.tick(500);
    expect(pool.getActiveLaneCount()).toBe(1);

    // Window 2: throughput improves a lot (simulating a second lane genuinely helping) -> grows.
    pool.acquireLane()!.send(new ArrayBuffer(2_500_000));
    controller.tick(500);
    expect(pool.getActiveLaneCount()).toBe(2);

    // Window 3 & 4: same aggregate throughput as window 2 (no real improvement) -> must stop growing and plateau.
    pool.acquireLane()!.send(new ArrayBuffer(2_500_000));
    controller.tick(500);
    expect(pool.getActiveLaneCount()).toBe(2);

    pool.acquireLane()!.send(new ArrayBuffer(2_500_000));
    controller.tick(500);
    expect(pool.getActiveLaneCount()).toBe(2);
    expect(controller.hasPlateaued()).toBe(true);
  });

  it("never exceeds the configured cap even if throughput keeps improving", () => {
    const lanes = Array.from({ length: 8 }, () => new FakeDataChannel(true));
    const pool = new TransportPool(lanes, 100_000_000, 10_000_000, 1);
    const controller = new AdaptiveLaneController(pool, 3); // cap below the pool's own max (8)

    let bytes = 1_000_000;
    controller.tick(500); // baseline (0 bytes sent yet)
    for (let i = 0; i < 6; i++) {
      bytes *= 2; // always "improving" a lot
      pool.acquireLane()!.send(new ArrayBuffer(bytes));
      controller.tick(500);
    }
    expect(pool.getActiveLaneCount()).toBe(3);
  });
});

describe("TransportPool: addLane / retireLaneByChannel", () => {
  it("addLane grows maxLaneCount without activating the new lane", () => {
    const lane0 = new FakeDataChannel(true);
    const pool = new TransportPool([lane0], 1_000_000, 100_000, 1);
    expect(pool.maxLaneCount).toBe(1);
    expect(pool.getActiveLaneCount()).toBe(1);

    const lane1 = new FakeDataChannel(true);
    pool.addLane(lane1);
    expect(pool.maxLaneCount).toBe(2);
    expect(pool.getActiveLaneCount()).toBe(1); // not activated just by adding it

    pool.setActiveLaneCount(2);
    expect(pool.getActiveLaneCount()).toBe(2);
  });

  it("retireLaneByChannel removes a lane and clamps activeLaneCount down if needed", () => {
    const lane0 = new FakeDataChannel(true);
    const lane1 = new FakeDataChannel(true);
    const pool = new TransportPool([lane0, lane1], 1_000_000, 100_000, 2);
    expect(pool.getActiveLaneCount()).toBe(2);

    pool.retireLaneByChannel(lane1);
    expect(pool.maxLaneCount).toBe(1);
    expect(pool.getActiveLaneCount()).toBe(1); // clamped — can't stay "2 active" with only 1 lane left

    // Retiring a channel that was never added is a harmless no-op.
    pool.retireLaneByChannel(new FakeDataChannel(true));
    expect(pool.maxLaneCount).toBe(1);
  });
});

describe("AdaptiveLaneController: async growLane (independent-PeerConnection lanes)", () => {
  it("fires growLane asynchronously without blocking tick(), and only activates the new lane once it resolves", async () => {
    const lane0 = new FakeDataChannel(true);
    const pool = new TransportPool([lane0], 100_000_000, 10_000_000, 1);

    let resolveGrow: ((ch: DataChannel | null) => void) | null = null;
    let growCalls = 0;
    const growLane = () => {
      growCalls++;
      return new Promise<DataChannel | null>((resolve) => {
        resolveGrow = resolve;
      });
    };
    const controller = new AdaptiveLaneController(pool, 8, 0.1, 0.02, growLane);

    pool.acquireLane()!.send(new ArrayBuffer(1_000_000));
    controller.tick(500); // baseline — never calls growLane on the first sample
    expect(growCalls).toBe(0);

    pool.acquireLane()!.send(new ArrayBuffer(2_500_000)); // big improvement -> should request growth
    controller.tick(500);
    expect(growCalls).toBe(1);
    // tick() must have returned WITHOUT waiting for growLane's promise —
    // the pool must still show only the original lane right now.
    expect(pool.maxLaneCount).toBe(1);
    expect(pool.getActiveLaneCount()).toBe(1);

    // A second improving tick while the first grow is still pending must
    // NOT fire a second concurrent negotiation (re-entrancy guard).
    pool.acquireLane()!.send(new ArrayBuffer(10_000_000));
    controller.tick(500);
    expect(growCalls).toBe(1);

    const lane1 = new FakeDataChannel(true);
    resolveGrow!(lane1);
    await flushMicrotasks();

    expect(pool.maxLaneCount).toBe(2);
    expect(pool.getActiveLaneCount()).toBe(2);
  });

  it("a failed growLane negotiation leaves the lane count unchanged and allows a later retry", async () => {
    const lane0 = new FakeDataChannel(true);
    const pool = new TransportPool([lane0], 100_000_000, 10_000_000, 1);
    let attempt = 0;
    const growLane = () => (attempt++ === 0 ? Promise.resolve(null) : Promise.resolve(new FakeDataChannel(true)));
    const controller = new AdaptiveLaneController(pool, 8, 0.1, 0.02, growLane);

    pool.acquireLane()!.send(new ArrayBuffer(1_000_000));
    controller.tick(500);
    pool.acquireLane()!.send(new ArrayBuffer(2_500_000));
    controller.tick(500); // first grow attempt -> resolves to null (negotiation failed)
    await flushMicrotasks();
    expect(pool.maxLaneCount).toBe(1);

    pool.acquireLane()!.send(new ArrayBuffer(10_000_000));
    controller.tick(500); // still improving -> retries, this time succeeds
    await flushMicrotasks();
    expect(pool.maxLaneCount).toBe(2);
  });
});
