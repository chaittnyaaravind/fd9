import { describe, expect, it, vi } from "vitest";
import { SignalingClient } from "../public/signalingClient.js";

/**
 * Regression test for the Mac<->iPhone pairing failure: an SDP answer (and,
 * by the same mechanism, an ICE candidate) arriving on the signaling
 * WebSocket BEFORE the receiving side has registered its matching
 * waitFor()/onMessage() listener used to be dropped permanently — not
 * delayed. Both peers independently await their own
 * request-turn-credentials round-trip before registering their
 * waitFor("relay-sdp") listener, with no ordering guarantee between the
 * two peers' round-trips, so the faster peer's message could (and did, in
 * a real cross-device test) arrive first and vanish. This reproduces that
 * exact ordering directly against the fixed SignalingClient.
 */

/** Minimal WebSocket stub: a constructor, assignable onopen/onmessage, and a way for the test to simulate an incoming frame. */
class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  send = vi.fn();
  constructor(_url: string) {}
  /** Test helper, not part of the real WebSocket API. */
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("SignalingClient — message delivered before the matching listener is registered", () => {
  it("is queued and replayed to a waitFor() call registered afterward, not dropped", async () => {
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    const client = new SignalingClient("ws://example.invalid");
    const fakeWs = client.ws as unknown as FakeWebSocket;

    // Simulates the real race: the offer/answer arrives on the wire BEFORE
    // this side has called waitFor("relay-sdp") — exactly what happened
    // when one peer's request-turn-credentials round-trip finished first.
    fakeWs.deliver({ type: "relay-sdp", payload: { type: "answer", sdp: "v=0..." } });

    // Only AFTER the message already arrived does this side register its wait.
    const msg = await client.waitFor("relay-sdp", 1000);
    expect((msg.payload as { sdp: string }).sdp).toBe("v=0...");
  });

  it("is queued and replayed to an onMessage() permanent handler registered afterward (the ICE-candidate case)", async () => {
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    const client = new SignalingClient("ws://example.invalid");
    const fakeWs = client.ws as unknown as FakeWebSocket;

    fakeWs.deliver({ type: "relay-ice", payload: { candidate: "candidate:1 1 UDP ..." } });

    const received: unknown[] = [];
    client.onMessage((m) => {
      if (m.type === "relay-ice") received.push(m);
    });

    expect(received).toHaveLength(1);
  });

  it("still resolves immediately when the message arrives after the waitFor() call (normal ordering, unaffected by the fix)", async () => {
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    const client = new SignalingClient("ws://example.invalid");
    const fakeWs = client.ws as unknown as FakeWebSocket;

    const pending = client.waitFor("room-created", 1000);
    fakeWs.deliver({ type: "room-created", code: "ABCD12" });
    const msg = await pending;
    expect(msg.code).toBe("ABCD12");
  });

  it("rejects a pending waitFor() when a server error arrives, queued or not", async () => {
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    const client = new SignalingClient("ws://example.invalid");
    const fakeWs = client.ws as unknown as FakeWebSocket;

    fakeWs.deliver({ type: "error", code: "room-not-found", message: "nope" });
    await expect(client.waitFor("joined", 1000)).rejects.toThrow(/signaling error/);
  });

  it("still times out when nothing ever arrives (no change to that behavior)", async () => {
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    const client = new SignalingClient("ws://example.invalid");
    await expect(client.waitFor("relay-sdp", 50)).rejects.toThrow(/timeout waiting for/);
  });
});
