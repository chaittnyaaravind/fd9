import type { DataChannel } from "./channels.js";

/** Cap on how many lanes the adaptive controller will ever grow to — lane 0 is the primary connection's existing data channel (the N=1 fallback); any lane beyond that is a genuinely independent RTCPeerConnection, created on demand as throughput justifies it, never pre-opened. */
export const MAX_LANES = 8;

/**
 * Wraps one DataChannel with its own backpressure watermark pair and a
 * rolling bytes-sent counter — the exact single-channel backpressure logic
 * SenderEngine used to own directly (`waitUntilReadyToSend`/
 * `waitForBufferedAmountZero`), now scoped per lane so N lanes each drain
 * independently (requirement: each connection has independent backpressure).
 */
export class TransportLane {
  private bufferedWaiter: (() => void) | null = null;
  private bytesSentWindow = 0;

  constructor(
    readonly id: number,
    private readonly channel: DataChannel,
    private readonly highWatermark: number,
    private readonly lowWatermark: number
  ) {
    this.channel.bufferedAmountLowThreshold = lowWatermark;
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  get isReady(): boolean {
    return this.channel.bufferedAmount <= this.highWatermark;
  }

  /** Check-BEFORE-send: never call send() while already at/over this lane's high watermark. */
  send(frame: ArrayBuffer): void {
    this.channel.send(frame);
    this.bytesSentWindow += frame.byteLength;
  }

  async waitUntilReady(): Promise<void> {
    while (this.channel.bufferedAmount > this.highWatermark) {
      await new Promise<void>((resolve) => {
        this.bufferedWaiter = resolve;
        this.channel.onBufferedAmountLow(resolve);
      });
    }
  }

  /** Generalization of the old single-channel waitForBufferedAmountZero, scoped to this one lane. */
  async drain(): Promise<void> {
    if (this.channel.bufferedAmount === 0) return;
    const originalThreshold = this.channel.bufferedAmountLowThreshold;
    this.channel.bufferedAmountLowThreshold = 0;
    await new Promise<void>((resolve) => this.channel.onBufferedAmountLow(resolve));
    this.channel.bufferedAmountLowThreshold = originalThreshold;
  }

  /** Unsticks anything awaiting this lane — used by abort paths. */
  forceRelease(): void {
    this.bufferedWaiter?.();
  }

  /** Sampled by AdaptiveLaneController once per window; resets the counter. */
  takeBytesSentAndReset(): number {
    const bytes = this.bytesSentWindow;
    this.bytesSentWindow = 0;
    return bytes;
  }

  /** Identity check used by TransportPool.retireLaneByChannel — avoids exposing the wrapped channel itself. */
  wraps(channel: DataChannel): boolean {
    return this.channel === channel;
  }
}

/**
 * Owns N pre-negotiated DataChannel lanes and hands out whichever ACTIVE
 * lane is currently able to accept more data (pull-based / work-stealing —
 * a faster lane naturally gets more chunks without any proportional-share
 * math, since it simply becomes ready again sooner).
 */
export class TransportPool {
  private lanes: TransportLane[];
  private activeLaneCount: number;
  private nextLaneId: number;

  constructor(
    channels: DataChannel[],
    private readonly highWatermark: number,
    private readonly lowWatermark: number,
    initialActiveLanes = 1
  ) {
    this.lanes = channels.map((ch, i) => new TransportLane(i, ch, highWatermark, lowWatermark));
    this.activeLaneCount = Math.max(1, Math.min(initialActiveLanes, this.lanes.length));
    this.nextLaneId = this.lanes.length;
  }

  get maxLaneCount(): number {
    return this.lanes.length;
  }

  /** Appends a lane backed by an independently-negotiated channel (e.g. its own RTCPeerConnection/SCTP association — see peerLane.ts) — NOT activated automatically; the caller (AdaptiveLaneController) raises activeLaneCount once it wants real work sent to it. */
  addLane(channel: DataChannel): void {
    this.lanes.push(new TransportLane(this.nextLaneId++, channel, this.highWatermark, this.lowWatermark));
  }

  /**
   * Removes a lane whose underlying connection died (e.g. its independent
   * RTCPeerConnection failed). Deliberately does NOT try to track/requeue
   * whatever chunks were in flight on it by range — the caller (see
   * SenderEngine.handleLaneFailure) instead reseeks sendCursor to the last
   * CONFIRMED offset and lets the normal dispatch loop resend via surviving
   * lanes, the same mechanism already used for a full connection drop.
   */
  retireLaneByChannel(channel: DataChannel): void {
    const idx = this.lanes.findIndex((l) => l.wraps(channel));
    if (idx === -1) return;
    this.lanes.splice(idx, 1);
    if (this.activeLaneCount > this.lanes.length) this.activeLaneCount = Math.max(1, this.lanes.length);
  }

  getActiveLaneCount(): number {
    return this.activeLaneCount;
  }

  setActiveLaneCount(n: number): void {
    this.activeLaneCount = Math.max(1, Math.min(n, this.lanes.length));
  }

  private activeLanes(): TransportLane[] {
    return this.lanes.slice(0, this.activeLaneCount);
  }

  /** Pull-based: the first ready active lane, or null if none currently are. */
  acquireLane(): TransportLane | null {
    for (const lane of this.activeLanes()) {
      if (lane.isReady) return lane;
    }
    return null;
  }

  /** Waits until at least one active lane is ready, then returns it. */
  async waitForAnyReady(): Promise<TransportLane> {
    for (;;) {
      const lane = this.acquireLane();
      if (lane) return lane;
      await Promise.race(this.activeLanes().map((l) => l.waitUntilReady()));
    }
  }

  /** Drains every lane ever used (not just currently-active ones — a lane deactivated mid-transfer may still have bytes in flight that must finish before a file-trailer is safe to send). */
  async drainAll(): Promise<void> {
    await Promise.all(this.lanes.map((lane) => lane.drain()));
  }

  forceReleaseAll(): void {
    for (const lane of this.lanes) lane.forceRelease();
  }

  /** Aggregate bytes sent across ACTIVE lanes since the last sample, for the adaptive controller. Resets each sampled lane's counter. */
  sampleActiveThroughputBytes(): number {
    let total = 0;
    for (const lane of this.activeLanes()) total += lane.takeBytesSentAndReset();
    return total;
  }
}

/**
 * Grow-until-plateau concurrency controller. Samples aggregate throughput
 * on a fixed cadence (driven by the caller's own loop, not an owned timer —
 * trivially unit-testable with synthetic ticks) and grows active lane count
 * while it's still helping; stops growing once improvement goes flat for
 * two consecutive windows. No active shrink in this version — avoids
 * thrashing, and still satisfies "stop adding when it stops helping."
 */
export class AdaptiveLaneController {
  private lastThroughputBytesPerSec = 0;
  private plateauCount = 0;
  private growthPending = false;

  constructor(
    private readonly pool: TransportPool,
    private readonly maxLanes = MAX_LANES,
    private readonly growThreshold = 0.1,
    private readonly plateauThreshold = 0.02,
    /**
     * When provided, growth beyond the lanes passed to TransportPool's
     * constructor creates a genuinely NEW independent transport (its own
     * RTCPeerConnection/SCTP association — see peerLane.ts) instead of
     * merely activating an already-open sibling channel. This is
     * necessarily async (real ICE/DTLS negotiation) and is fired without
     * blocking tick() or the caller's hot send loop. When omitted (every
     * existing test/the N=1 fallback), growth is exactly the original
     * synchronous "activate an already-provisioned lane" behavior, capped
     * at however many lanes were actually passed in.
     */
    private readonly growLane?: () => Promise<DataChannel | null>
  ) {}

  /** Call roughly every ~500ms from the engine's own send loop. */
  tick(elapsedSinceLastTickMs: number): void {
    if (elapsedSinceLastTickMs <= 0) return;
    const bytes = this.pool.sampleActiveThroughputBytes();
    const throughputBytesPerSec = bytes / (elapsedSinceLastTickMs / 1000);

    if (this.lastThroughputBytesPerSec > 0) {
      const improvement = (throughputBytesPerSec - this.lastThroughputBytesPerSec) / this.lastThroughputBytesPerSec;
      const cap = this.growLane ? this.maxLanes : Math.min(this.maxLanes, this.pool.maxLaneCount);
      if (improvement >= this.growThreshold && this.pool.getActiveLaneCount() < cap) {
        if (this.growLane) this.requestGrow();
        else this.pool.setActiveLaneCount(this.pool.getActiveLaneCount() + 1);
        this.plateauCount = 0;
      } else if (improvement < this.plateauThreshold) {
        this.plateauCount++;
      } else {
        this.plateauCount = 0;
      }
    }
    this.lastThroughputBytesPerSec = throughputBytesPerSec;
  }

  /** Fire-and-forget, re-entrancy-guarded so a slow negotiation can't be requested twice in a row while still pending. */
  private requestGrow(): void {
    if (!this.growLane || this.growthPending) return;
    this.growthPending = true;
    void this.growLane()
      .then((channel) => {
        if (channel) {
          this.pool.addLane(channel);
          this.pool.setActiveLaneCount(this.pool.getActiveLaneCount() + 1);
        }
      })
      .catch(() => {
        /* a failed negotiation just means staying at the current lane count — not fatal to the transfer */
      })
      .finally(() => {
        this.growthPending = false;
      });
  }

  /** True once growth has stopped helping for two consecutive windows — exposed for diagnostics/tests, not required for the grow logic itself (which self-limits via growThreshold). */
  hasPlateaued(): boolean {
    return this.plateauCount >= 2;
  }
}
