import {
  BUFFERED_AMOUNT_HIGH_WATERMARK,
  BUFFERED_AMOUNT_LOW_WATERMARK,
  controlMessageSchema,
  DEFAULT_CHUNK_SIZE,
  encodeChunkFrame,
  SEND_RETRY_DELAYS_MS,
  type ControlMessage,
  type OfferedFile
} from "@fd9/protocol";
import type { ControlChannel, DataChannel } from "./channels.js";
import { Emitter } from "./emitter.js";
import { IncrementalHasher } from "./hashing.js";
import { AdaptiveLaneController, TransportPool, type TransportLane } from "./transportPool.js";
import type { ChunkReadable, FileProgress, SendableFile } from "./types.js";

/**
 * Phase-0 throughput audit instrumentation: cumulative time spent in each
 * pipeline stage, so a bottleneck can be identified by measurement instead
 * of assumption. `readMs` isolates disk/source-read cost — with a
 * SyntheticChunkSource (benchmark mode) this is near-zero by construction,
 * which is what actually proves whether disk I/O or something else (JS
 * pipeline, hashing, DataChannel backpressure, UI overhead) dominates.
 */
export interface SenderPipelineStats {
  fileIndex: number;
  bytesSent: number;
  elapsedMs: number;
  /** Stage A: time inside readChunkAt (source.slice().arrayBuffer()). */
  readMs: number;
  /** Time blocked on dataChannel.bufferedAmount backpressure — reflects network/receiver saturation, not sender-side cost. */
  backpressureWaitMs: number;
  /** Stage B: time inside encodeChunkFrame + the actual data.send() call. */
  sendCallMs: number;
  /** Time inside IncrementalHasher.update() — tracked separately since pure-JS SHA-256 was flagged as a suspected bottleneck. */
  hashMs: number;
  /** Stage F: time inside emitProgress() (the React/Zustand state-update cost). */
  uiMs: number;
}

export type SenderEvents = {
  progress: FileProgress[];
  "offer-response": { accepted: number[]; rejected: number[] };
  "session-complete": undefined;
  "pipeline-stats": SenderPipelineStats;
};

/**
 * Drives one sender-side session over an already-open control channel plus
 * a pool of one or more parallel data-channel "lanes" (see
 * transportPool.ts). Files are still sent strictly one at a time (never
 * interleaved) so a slow/cancelled file can't corrupt another's byte
 * stream on the wire — but a SINGLE file's chunks are now dispatched
 * across however many lanes the adaptive controller has activated. The
 * read+hash loop stays fully sequential (unchanged from the single-lane
 * version); only chunk dispatch (which lane physically sends it) is
 * parallel, which is what keeps SHA-256 hashing correct with zero
 * reordering logic needed on the sender side.
 */
export class SenderEngine {
  private readonly emitter = new Emitter<SenderEvents>();
  private readonly progress = new Map<number, FileProgress>();
  private readonly files: Map<number, SendableFile>;
  private readonly paused = new Set<number>();
  private readonly cancelled = new Set<number>();
  private readonly resumeWaiters = new Map<number, () => void>();
  private readonly fileCompleteWaiters = new Map<number, () => void>();
  /** Resolved (and re-armed) on every chunk-ack — lets sendOneFile wake up and re-check whether confirmedBytes has reached the full file size yet, instead of relying on the local send buffer alone (see waitForFullConfirmation). */
  private readonly confirmationWaiters = new Map<number, () => void>();
  private readonly pool: TransportPool;
  private readonly laneController: AdaptiveLaneController;
  private lastLaneSampleAt = 0;
  private aborted = false;
  /** Set when a reconnect happens mid-file — the in-flight send loop can't know which of its already-"sent" bytes actually arrived, so it restarts this one file from scratch. */
  private restartCurrent = false;

  // --- Phase-0 pipeline instrumentation (see SenderPipelineStats) ---
  private statsStartedAt = 0;
  private statsBytesSent = 0;
  private statsReadMs = 0;
  private statsBackpressureWaitMs = 0;
  private statsSendCallMs = 0;
  private statsHashMs = 0;
  private statsUiMs = 0;
  private lastStatsEmitAt = 0;

  constructor(
    private readonly control: ControlChannel,
    lanes: DataChannel[],
    files: SendableFile[],
    private readonly chunkSize = DEFAULT_CHUNK_SIZE,
    /** Override point for the benchmark sweep (session.ts's `?sendWindowMiB=`) — production default is the protocol constant. Applied PER LANE, not aggregate, so each lane independently backpressures. */
    private readonly highWatermark = BUFFERED_AMOUNT_HIGH_WATERMARK,
    private readonly lowWatermark = BUFFERED_AMOUNT_LOW_WATERMARK,
    /** How many of the lanes passed in to start actively using — seeded by the caller from direct-vs-relay link quality (1 direct, 2 relay is the recommended seed; see session.ts). The adaptive controller grows from here. */
    initialActiveLanes = 1,
    /**
     * When provided, growth beyond the lanes passed in creates a genuinely
     * independent RTCPeerConnection-backed lane (see transfer/peerLane.ts)
     * instead of merely activating an already-open sibling channel — see
     * AdaptiveLaneController. Each call gets a fresh, locally-generated
     * connection id.
     */
    growLane?: (connectionId: string) => Promise<DataChannel | null>
  ) {
    this.files = new Map(files.map((f) => [f.fileIndex, f]));
    for (const f of files) {
      this.progress.set(f.fileIndex, {
        fileIndex: f.fileIndex,
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        bytesMoved: 0,
        confirmedBytes: 0,
        status: "queued"
      });
    }
    this.pool = new TransportPool(lanes, this.highWatermark, this.lowWatermark, initialActiveLanes);
    let nextLaneConnectionId = lanes.length;
    this.laneController = new AdaptiveLaneController(
      this.pool,
      undefined,
      undefined,
      undefined,
      growLane ? () => growLane(`lane-${nextLaneConnectionId++}`) : undefined
    );
    this.control.onMessage((json) => this.handleControl(json));
  }

  on<K extends keyof SenderEvents>(event: K, listener: (payload: SenderEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  async offer(): Promise<void> {
    const files: OfferedFile[] = Array.from(this.files.values()).map((f) => ({
      fileIndex: f.fileIndex,
      name: f.name,
      size: f.size,
      mimeType: f.mimeType
    }));
    this.sendControl({ type: "file-offer", files });
  }

  pause(fileIndex: number): void {
    this.paused.add(fileIndex);
    this.sendControl({ type: "pause", fileIndex });
    this.setStatus(fileIndex, "paused", (p) => p.status === "transferring");
  }

  resume(fileIndex: number): void {
    this.paused.delete(fileIndex);
    this.sendControl({ type: "resume", fileIndex });
    this.setStatus(fileIndex, "transferring", (p) => p.status === "paused");
    this.resumeWaiters.get(fileIndex)?.();
  }

  cancel(fileIndex: number): void {
    this.cancelled.add(fileIndex);
    this.sendControl({ type: "cancel", fileIndex, reason: "user" });
    this.setStatus(fileIndex, "cancelled");
    this.resumeWaiters.get(fileIndex)?.();
    this.confirmationWaiters.get(fileIndex)?.();
    this.pool.forceReleaseAll();
  }

  /**
   * Called by the owning session right after a reconnect/ICE-restart
   * succeeds. A brief data-channel interruption risks silent loss of
   * already-"sent"-but-unacknowledged bytes (if the browser rebuilt the
   * underlying SCTP association, not just ICE connectivity) — so the file
   * actively in flight reseeks to the receiver's last *confirmed* offset
   * (`progress.confirmedBytes`, from its chunk-acks) and resumes from there,
   * rather than restarting from byte 0. For a multi-GB file that gap is at
   * most a few hundred KiB/ms of unacked data, not the whole file — the
   * receiver dedupes the small resulting overlap (see receiver.ts). Files
   * not yet started, already completed, or queued are unaffected.
   */
  handleReconnect(): void {
    for (const p of this.progress.values()) {
      if (p.status === "transferring" || p.status === "verifying") {
        this.restartCurrent = true;
        // Unstick a sendOneFile that's waiting on an ack which may now never arrive.
        this.fileCompleteWaiters.get(p.fileIndex)?.();
        this.fileCompleteWaiters.delete(p.fileIndex);
        this.confirmationWaiters.get(p.fileIndex)?.();
        this.confirmationWaiters.delete(p.fileIndex);
      }
    }
  }

  /**
   * Called by the owning session when ONE secondary lane's independent
   * RTCPeerConnection fails (not the whole session — see peerLane.ts's
   * onFailed). Deliberately reuses handleReconnect() as-is rather than
   * tracking which byte ranges were in flight on the dead lane
   * specifically: removing the lane then reseeking to the last CONFIRMED
   * offset causes the normal dispatch loop to resend anything unconfirmed
   * via the SURVIVING lanes, with the receiver's existing frontier-relative
   * trim deduping the harmless overlap — the same mechanism a full
   * connection drop already relies on, just scoped to one lane dying
   * instead of all of them. This is what keeps one lane's failure from
   * destroying the whole transfer.
   */
  handleLaneFailure(channel: DataChannel): void {
    this.pool.retireLaneByChannel(channel);
    this.handleReconnect();
  }

  /** Called by the owning session on connection loss — stops everything promptly. */
  abortAll(message: string): void {
    this.aborted = true;
    for (const p of this.progress.values()) {
      if (p.status !== "completed" && p.status !== "rejected") {
        p.status = "failed";
        p.error = message;
      }
    }
    this.emitProgress();
    for (const resolve of this.resumeWaiters.values()) resolve();
    for (const resolve of this.fileCompleteWaiters.values()) resolve();
    this.fileCompleteWaiters.clear();
    for (const resolve of this.confirmationWaiters.values()) resolve();
    this.confirmationWaiters.clear();
    this.pool.forceReleaseAll();
  }

  private setStatus(fileIndex: number, status: FileProgress["status"], when?: (p: FileProgress) => boolean): void {
    const p = this.progress.get(fileIndex);
    if (p && (!when || when(p))) p.status = status;
    this.emitProgress();
  }

  private emitProgress(): void {
    const t0 = performance.now();
    this.emitter.emit("progress", Array.from(this.progress.values()));
    this.statsUiMs += performance.now() - t0;
  }

  /**
   * Phase 1 fix: emitProgress() on every single chunk means a React
   * re-render per 256 KiB at GB-scale throughput (thousands of re-renders
   * for a 1 GB file) — exactly the "UI overhead per packet" the spec
   * prohibits, and confirmed as real (not assumed) overhead once measured
   * in a real browser. Used only on the hot per-chunk path; every status
   * transition (start/pause/resume/complete/fail/cancel) still calls the
   * unconditional emitProgress() directly so the UI never looks stuck.
   */
  private lastProgressEmitAt = 0;
  private emitProgressThrottled(): void {
    const now = performance.now();
    if (now - this.lastProgressEmitAt < 100) return;
    this.lastProgressEmitAt = now;
    this.emitProgress();
  }

  /** Throttled (not per-chunk) — emitting this itself on every chunk would just reintroduce the same per-packet overhead problem it's measuring. */
  private maybeEmitPipelineStats(fileIndex: number, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastStatsEmitAt < 250) return;
    this.lastStatsEmitAt = now;
    this.emitter.emit("pipeline-stats", {
      fileIndex,
      bytesSent: this.statsBytesSent,
      elapsedMs: now - this.statsStartedAt,
      readMs: this.statsReadMs,
      backpressureWaitMs: this.statsBackpressureWaitMs,
      sendCallMs: this.statsSendCallMs,
      hashMs: this.statsHashMs,
      uiMs: this.statsUiMs
    });
  }

  private sendControl(message: ControlMessage): void {
    this.control.send(JSON.stringify(message));
  }

  private handleControl(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    const result = controlMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const msg = result.data;

    switch (msg.type) {
      case "file-offer-response": {
        for (const idx of msg.rejected) this.setStatus(idx, "rejected");
        this.emitter.emit("offer-response", { accepted: msg.accepted, rejected: msg.rejected });
        // Durable resume (closed/reloaded tab on the RECEIVER side): it
        // already has some persisted, verified-on-disk bytes of this file
        // from a prior session and is asking to resume from there instead
        // of byte 0 — see resumeStore.ts and sendOneFile's catch-up hash.
        const resumeFromOffsets = new Map<number, number>();
        for (const r of msg.resumeFrom ?? []) resumeFromOffsets.set(r.fileIndex, r.offset);
        void this.runQueue(msg.accepted, resumeFromOffsets);
        return;
      }
      case "chunk-ack": {
        const p = this.progress.get(msg.fileIndex);
        if (p) {
          // Confirmed bytes must never regress: a stale/out-of-order ack
          // reporting less than what's already confirmed would otherwise
          // falsely re-arm waitForFullConfirmation's wait after the
          // receiver has already finished (it has nothing left to send).
          p.confirmedBytes = Math.max(p.confirmedBytes, msg.confirmedBytes);
          this.emitProgress();
        }
        this.confirmationWaiters.get(msg.fileIndex)?.();
        return;
      }
      case "file-complete": {
        const p = this.progress.get(msg.fileIndex);
        if (p) {
          p.status = msg.ok ? "completed" : "failed";
          if (!msg.ok) p.error = "Integrity check failed on the receiving device.";
        }
        this.emitProgress();
        this.fileCompleteWaiters.get(msg.fileIndex)?.();
        this.fileCompleteWaiters.delete(msg.fileIndex);
        return;
      }
      case "pause":
        this.paused.add(msg.fileIndex);
        this.setStatus(msg.fileIndex, "paused", (p) => p.status === "transferring");
        return;
      case "resume":
        this.paused.delete(msg.fileIndex);
        this.setStatus(msg.fileIndex, "transferring", (p) => p.status === "paused");
        this.resumeWaiters.get(msg.fileIndex)?.();
        return;
      case "cancel":
        this.cancelled.add(msg.fileIndex);
        this.setStatus(msg.fileIndex, "cancelled");
        this.resumeWaiters.get(msg.fileIndex)?.();
        return;
      default:
        return;
    }
  }

  private async waitWhilePaused(fileIndex: number): Promise<void> {
    while (this.paused.has(fileIndex) && !this.cancelled.has(fileIndex) && !this.aborted) {
      await new Promise<void>((resolve) => this.resumeWaiters.set(fileIndex, resolve));
    }
  }

  /**
   * Waits until the receiver has explicitly acked the FULL file size —
   * see sendOneFile's call site for why drainAll() alone (local send
   * buffer empty) is not sufficient proof the peer actually has
   * everything. Re-armed on every chunk-ack via confirmationWaiters;
   * bails out the same way waitWhilePaused does on abort/cancel/reconnect
   * so a dropped connection can't leave this waiting forever.
   */
  private async waitForFullConfirmation(file: SendableFile, progress: FileProgress): Promise<void> {
    while (
      progress.confirmedBytes < file.size &&
      !this.cancelled.has(file.fileIndex) &&
      !this.aborted &&
      !this.restartCurrent
    ) {
      await new Promise<void>((resolve) => this.confirmationWaiters.set(file.fileIndex, resolve));
    }
  }

  /**
   * `RTCDataChannel.send()` can itself throw synchronously — most notably
   * "RTCDataChannel send queue is full" — when the browser's own internal
   * send buffer hits its real ceiling, which over a slow/relayed link can be
   * reached even while our JS-side `bufferedAmount` watermark looked fine.
   * That is backpressure, not a fatal error: wait for the SAME lane to
   * actually drain and retry with bounded backoff, rather than letting the
   * exception kill the whole file (the original bug this fixes).
   */
  private async sendChunkWithRetry(lane: TransportLane, frame: ArrayBuffer): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        lane.send(frame);
        return;
      } catch (err) {
        if (attempt >= SEND_RETRY_DELAYS_MS.length) throw err;
        await lane.waitUntilReady();
        await new Promise<void>((resolve) => setTimeout(resolve, SEND_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  /**
   * Every ~500ms of real send-loop progress, samples aggregate throughput
   * across active lanes and lets the adaptive controller decide whether to
   * activate another one. Throttled like the existing stats emitters —
   * driven by the loop's own cadence, not an owned timer.
   */
  private maybeAdaptLaneCount(): void {
    const now = performance.now();
    if (now - this.lastLaneSampleAt < 500) return;
    const elapsed = this.lastLaneSampleAt === 0 ? 500 : now - this.lastLaneSampleAt;
    this.lastLaneSampleAt = now;
    this.laneController.tick(elapsed);
  }

  private async runQueue(acceptedIndices: number[], resumeFromOffsets: Map<number, number>): Promise<void> {
    for (const fileIndex of acceptedIndices) {
      if (this.aborted || this.cancelled.has(fileIndex)) continue;
      const file = this.files.get(fileIndex);
      const progress = this.progress.get(fileIndex);
      if (!file || !progress) continue;
      try {
        await this.sendOneFile(file, progress, resumeFromOffsets.get(fileIndex) ?? 0);
      } catch (err) {
        progress.status = "failed";
        progress.error = err instanceof Error ? err.message : "Transfer failed.";
        this.emitProgress();
      }
      if (this.aborted) break;
    }
    if (!this.aborted) {
      this.sendControl({ type: "session-complete" });
      this.emitter.emit("session-complete", undefined);
    }
  }

  /**
   * Reads via seekable `.slice()` (not a forward-only stream) so a
   * reconnect mid-file can reseek and resume instead of restarting — each
   * slice is read lazily, so this never holds more than one chunk of the
   * file in memory regardless of file size (same bound as the old
   * stream-based reader, just random-access instead of sequential). Takes
   * a `ChunkReadable`, not a concrete `Blob` — a real `File`/`Blob` already
   * satisfies that structurally; a `SyntheticChunkSource` (benchmark mode)
   * satisfies it too, with zero real disk I/O.
   */
  private async readChunkAt(source: ChunkReadable, start: number, size: number): Promise<Uint8Array> {
    const buf = await source.slice(start, Math.min(start + size, source.size)).arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * `initialOffset` is durable resume (closed/reloaded RECEIVER tab, not a
   * live reconnect — that's `restartCurrent` below): the receiver already
   * has `initialOffset` verified, persisted bytes of this file from a
   * prior session, so this run sends only the remainder. The receiver's
   * own full-file integrity check still needs a digest of the WHOLE file
   * though, so a fresh hasher here first catches up on [0, initialOffset)
   * — read and hashed, but deliberately never sent — before the normal
   * send loop takes over from initialOffset onward.
   */
  private async sendOneFile(file: SendableFile, progress: FileProgress, initialOffset = 0): Promise<void> {
    this.restartCurrent = false;
    progress.status = "transferring";
    progress.bytesMoved = initialOffset;
    this.emitProgress();
    this.sendControl({ type: "transfer-start", fileIndex: file.fileIndex, chunkSize: this.chunkSize, resumeFromOffset: initialOffset });

    this.statsStartedAt = performance.now();
    this.statsBytesSent = 0;
    this.statsReadMs = 0;
    this.statsBackpressureWaitMs = 0;
    this.statsSendCallMs = 0;
    this.statsHashMs = 0;
    this.statsUiMs = 0;
    this.lastStatsEmitAt = 0;

    const hasher = new IncrementalHasher();
    let hashedOffset = 0; // bytes actually fed into the hasher so far — monotonic, never rewound
    let sendCursor = 0; // bytes actually sent over the wire so far — CAN rewind on a reconnect-triggered reseek

    // Catch-up hashing pass for a durable resume — never sent, only hashed,
    // so the final digest covers the whole file despite skipping straight
    // to initialOffset for the actual send loop below.
    while (hashedOffset < initialOffset) {
      if (this.aborted || this.cancelled.has(file.fileIndex)) {
        progress.status = "cancelled";
        this.emitProgress();
        return;
      }
      const chunk = await this.readChunkAt(file.source, hashedOffset, this.chunkSize);
      await hasher.update(chunk);
      hashedOffset += chunk.byteLength;
    }
    sendCursor = initialOffset;

    let trailerSent = false;

    // Phase 1 fix: read chunk N+1 while chunk N is still being sent/waiting
    // on backpressure, instead of strictly serial read-then-send-then-loop.
    // Bounded to exactly one chunk ahead (never an unbounded prefetch
    // queue) — still fully decouples read latency from send latency, which
    // Phase 0's audit identified as a real bottleneck (nothing overlapped
    // before this). Invalidated on any reseek, since the cursor can jump
    // arbitrarily on reconnect and a stale prefetch would be for the wrong
    // offset entirely.
    let pendingChunk: { offset: number; promise: Promise<Uint8Array> } | null = null;

    // Single loop for the whole file lifecycle (sending bytes, then the
    // trailer+ack handshake) so a reconnect signal at ANY point just reseeks
    // `sendCursor` and falls through naturally — never recreates the hasher,
    // never restarts a multi-GB file from scratch.
    for (;;) {
      if (this.aborted || this.cancelled.has(file.fileIndex)) {
        progress.status = "cancelled";
        this.emitProgress();
        return;
      }
      if (this.restartCurrent) {
        // Reseek to the receiver's last CONFIRMED byte, not byte 0 — the
        // small overlap this resends gets deduped on the receiving end
        // (see receiver.ts), so a multi-GB file never restarts from scratch.
        this.restartCurrent = false;
        trailerSent = false;
        sendCursor = Math.min(progress.confirmedBytes, hashedOffset);
        pendingChunk = null; // the old prefetch (if any) is for the wrong offset now
        this.sendControl({ type: "transfer-start", fileIndex: file.fileIndex, chunkSize: this.chunkSize, resumeFromOffset: sendCursor });
        continue;
      }

      if (sendCursor < file.size) {
        await this.waitWhilePaused(file.fileIndex);
        if (this.aborted || this.cancelled.has(file.fileIndex)) {
          progress.status = "cancelled";
          this.emitProgress();
          return;
        }
        if (this.restartCurrent) continue;

        let tMark = performance.now();
        const lane = await this.pool.waitForAnyReady();
        this.statsBackpressureWaitMs += performance.now() - tMark;
        if (this.restartCurrent || this.aborted || this.cancelled.has(file.fileIndex)) continue;

        tMark = performance.now();
        let chunk: Uint8Array;
        if (pendingChunk && pendingChunk.offset === sendCursor) {
          chunk = await pendingChunk.promise;
        } else {
          // Cold start, or the prefetch was invalidated by a reseek — read fresh.
          chunk = await this.readChunkAt(file.source, sendCursor, this.chunkSize);
        }
        pendingChunk = null;
        this.statsReadMs += performance.now() - tMark;

        // Kick off the NEXT chunk's read now — it runs concurrently with
        // this chunk's backpressure-wait/send below instead of waiting for
        // them to finish first. Not awaited here; awaited on the loop's
        // next iteration (or discarded on reseek).
        const nextOffset: number = sendCursor + chunk.byteLength;
        if (nextOffset < file.size) {
          pendingChunk = { offset: nextOffset, promise: this.readChunkAt(file.source, nextOffset, this.chunkSize) };
        }

        tMark = performance.now();
        try {
          await this.sendChunkWithRetry(lane, encodeChunkFrame(file.fileIndex, sendCursor, chunk));
        } catch (err) {
          progress.status = "failed";
          progress.error = err instanceof Error ? err.message : "Failed to send file data.";
          this.emitProgress();
          return;
        }
        this.statsSendCallMs += performance.now() - tMark;
        this.statsBytesSent += chunk.byteLength;

        // Only hash bytes we haven't hashed yet — a resumed resend
        // re-transmits some already-hashed bytes (for the receiver to
        // dedupe) but must not be fed into the hasher twice.
        if (sendCursor >= hashedOffset) {
          tMark = performance.now();
          await hasher.update(chunk);
          this.statsHashMs += performance.now() - tMark;
          hashedOffset = sendCursor + chunk.byteLength;
        }
        sendCursor += chunk.byteLength;
        progress.bytesMoved = Math.max(progress.bytesMoved, sendCursor);
        this.emitProgressThrottled();
        this.maybeEmitPipelineStats(file.fileIndex);
        this.maybeAdaptLaneCount();
        continue;
      }

      // Every byte has been handed to send() — drain, then send the trailer
      // and wait for the receiver's own verified verdict (file-complete).
      // "I sent the trailer" and "the other side actually confirmed the
      // bytes" are not the same thing — declaring session-complete from the
      // sender side without this gap closed is exactly the false-success
      // bug spec section 23 forbids.
      if (this.aborted) return;
      await this.pool.drainAll();
      if (this.restartCurrent) continue;
      if (this.aborted) return;

      // drainAll() only proves every lane's LOCAL send buffer emptied —
      // per spec, bufferedAmount reaching 0 means "handed to the network,"
      // not "the peer has it." Confirmed directly in the N=2 multi-lane
      // investigation: confirmedBytes measured at just 37% of file.size
      // the instant drainAll() had already resolved in one real run over
      // independent, higher-RTT lanes. Waiting for the receiver's own
      // explicit ack of the FULL size closes that gap — without it, the
      // trailer can race ahead of data still legitimately in flight,
      // causing a spurious integrity failure on an otherwise-correct
      // transfer. (receiver.ts guarantees the final chunk always acks
      // unconditionally, so this cannot hang on a file size that doesn't
      // happen to align with the periodic ack interval/byte threshold.)
      await this.waitForFullConfirmation(file, progress);
      if (this.restartCurrent || this.aborted || this.cancelled.has(file.fileIndex)) continue;

      if (!trailerSent) {
        progress.status = "verifying";
        this.emitProgress();
        this.maybeEmitPipelineStats(file.fileIndex, true);
        this.sendControl({ type: "file-trailer", fileIndex: file.fileIndex, sha256Hex: await hasher.digestHex() });
        trailerSent = true;
      }

      await new Promise<void>((resolve) => this.fileCompleteWaiters.set(file.fileIndex, resolve));
      if (this.aborted) return;
      if (this.restartCurrent) continue; // handleReconnect resolved the waiter early — reseek/resend as needed
      return; // the real ack arrived
    }
  }
}
