import {
  ACK_BYTE_INTERVAL,
  ACK_INTERVAL_MS,
  controlMessageSchema,
  decodeChunkFrame,
  MEMORY_FALLBACK_MAX_BYTES,
  RECEIVE_BACKPRESSURE_HIGH_WATERMARK,
  RECEIVE_BACKPRESSURE_LOW_WATERMARK,
  type ControlMessage,
  type OfferedFile
} from "@fd9/protocol";
import type { ControlChannel, DataChannel } from "./channels.js";
import { Emitter } from "./emitter.js";
import { dedupeFilenames } from "./filenames.js";
import { IncrementalHasher } from "./hashing.js";
import {
  createIndexedDbSink,
  createMemorySink,
  createOpfsSink,
  reopenOpfsSink,
  supportsIndexedDb,
  supportsOpfs,
  type FileSink,
  type MemorySink
} from "./sinks.js";
import { deleteTransferRecord, findMatchingRecord, listIncompleteTransferRecords, saveTransferRecord, type TransferRecord } from "./resumeStore.js";
import type { FileProgress } from "./types.js";

interface FallbackSinkResult {
  sink: MemorySink;
  /** Non-null only for OPFS — what's persisted (resumeStore.ts) to reopen this exact file later via reopenOpfsSink. IndexedDB/memory sinks don't support durable cross-reload resume (see receiver.ts's accept()). */
  storageRef: string | null;
}

/**
 * Preference order for a file the caller didn't already stream to disk via
 * showSaveFilePicker: OPFS (real OS-backed sequential writes, cheapest
 * completion, AND the only mechanism durable resume supports — see
 * createOpfsSink) > IndexedDB (works everywhere else real browsers run) >
 * a hard-capped in-memory buffer (Node/vitest unit tests only, which have
 * neither OPFS nor IndexedDB — never a real browser, never hit with a
 * fixed file-size ceiling in practice).
 */
async function createFallbackSink(mimeType: string, suggestedName: string): Promise<FallbackSinkResult> {
  if (supportsOpfs) {
    try {
      const { sink, storageRef } = await createOpfsSink(mimeType, suggestedName);
      return { sink, storageRef };
    } catch {
      /* some origins/contexts restrict OPFS (e.g. no storage-isolated iframe) — fall through */
    }
  }
  const sink = supportsIndexedDb ? createIndexedDbSink(mimeType) : createMemorySink(mimeType, MEMORY_FALLBACK_MAX_BYTES);
  return { sink, storageRef: null };
}

export interface IncomingOffer {
  files: OfferedFile[];
  suggestedNames: string[];
}

/**
 * Instrumentation for the receive-side storage pipeline — see
 * RECEIVE_BACKPRESSURE_HIGH_WATERMARK in @fd9/protocol for why this exists.
 * `inFlightBytes` is the number that actually matters: bytes already handed
 * to `onmessage` but whose `sink.write()` hasn't resolved yet. That's the
 * quantity an unbounded receive queue would let grow forever; emitted here
 * so it can be watched (devtools, a debug overlay, a Playwright test) to
 * confirm it stays bounded instead of climbing for the life of a transfer.
 */
export interface ReceiveDiagnostics {
  fileIndex: number;
  bytesReceived: number;
  bytesPersisted: number;
  inFlightBytes: number;
  pendingWrites: number;
  backpressureActive: boolean;
  manualPauseActive: boolean;
  lastChunkAt: number;
  lastWriteAt: number;
}

/**
 * Phase-0 throughput audit instrumentation, receiver side — mirrors
 * SenderPipelineStats. `writeMs` isolates persistent-storage cost (stage
 * E); `decodeMs` is everything else JS-side per chunk (stage D); `uiMs` is
 * the React/Zustand state-update cost (stage F).
 */
export interface ReceiverPipelineStats {
  fileIndex: number;
  bytesReceived: number;
  elapsedMs: number;
  /** Stage D: decodeChunkFrame + resume-skip bookkeeping, excluding the write itself. */
  decodeMs: number;
  /** Stage E: time inside sink.write(). */
  writeMs: number;
  /** Time inside IncrementalHasher.update(). */
  hashMs: number;
  /** Stage F: time inside emitProgress()/emitDiagnostics(). */
  uiMs: number;
}

export type ReceiverEvents = {
  offer: IncomingOffer;
  progress: FileProgress[];
  "file-ready": { fileIndex: number; name: string; blob: Blob | null };
  "session-complete": undefined;
  "receive-diagnostics": ReceiveDiagnostics;
  "pipeline-stats": ReceiverPipelineStats;
};

export class ReceiverEngine {
  private readonly emitter = new Emitter<ReceiverEvents>();
  private readonly progress = new Map<number, FileProgress>();
  private readonly offeredFiles = new Map<number, OfferedFile>();
  private readonly sinks = new Map<number, FileSink>();

  private activeFileIndex: number | null = null;
  private activeHasher: IncrementalHasher | null = null;
  private activeWrittenBytes = 0;
  private lastAckAt = 0;
  private lastAckBytes = 0;
  /**
   * Chunks from any lane can arrive out of order relative to each other
   * (each lane is internally ordered, but N lanes racing independently are
   * not ordered relative to one another). Keyed by each chunk's own
   * absolute byteOffset (already carried in CHUNK_FRAME — no protocol
   * change needed), holding only the chunks that have arrived AHEAD of the
   * current write frontier (`activeWrittenBytes`); drained in offset order
   * into the same sequential write/hash/checkpoint/ack path every chunk
   * always went through. `releaseBytes` is each entry's ORIGINAL arrival
   * size (pre-trim) so backpressure accounting nets to zero correctly even
   * though the stored payload may have been trimmed against the frontier
   * (see the old `resumeSkipRemaining`'s replacement, below) — released
   * only once the chunk is actually written, not merely dequeued, so a
   * chunk buffered here while waiting for a slower lane still counts
   * against `inFlightBytes`/the existing backpressure watermarks (bounded
   * memory regardless of how far one lane gets ahead of another).
   */
  private readonly reorderBuffer = new Map<number, { payload: Uint8Array; releaseBytes: number }>();

  // --- Durable resume (surviving a closed/reloaded tab, not just a live reconnect) — see resumeStore.ts ---
  /** Populated during accept() for files matched against a persisted record; consumed by the transfer-start handler to seed a resumed hasher instead of a fresh one. */
  private readonly durableResumeState = new Map<number, { hashState: Uint8Array; transferId: string; storageRef: string }>();
  /** Populated during accept() for freshly-created (non-resumed) OPFS sinks, so progress can still be persisted for a FUTURE resume. */
  private readonly pendingStorageRefs = new Map<number, string>();
  private activeTransferId: string | null = null;
  private activeStorageRef: string | null = null;
  /** See maybePersistTransferRecord's docblock — geometric, not fixed-interval, spacing. */
  private lastCheckpointOffset = 0;
  /**
   * Serializes handleChunk calls strictly in arrival order. The data channel
   * delivers messages in order, but `onmessage` fires for each one without
   * waiting for the previous handler to finish — harmless when sink.write()
   * was effectively instant (the old in-memory array push), but a real
   * ordering hazard now that it can be a genuinely async IndexedDB write:
   * two overlapping handleChunk calls could otherwise update the running
   * hash (and written-bytes count) out of arrival order.
   */
  private chunkQueue: Promise<void> = Promise.resolve();

  // --- Storage backpressure + instrumentation (see ReceiveDiagnostics) ---
  /** Bytes handed to onmessage for the active file but not yet resolved by sink.write(). The quantity that must stay bounded. */
  private inFlightBytes = 0;
  /** How many chunk frames are currently in that unwritten state — pendingWrites in the diagnostics payload. */
  private pendingWrites = 0;
  private bytesReceivedTotal = 0;
  private lastChunkAt = 0;
  private lastWriteAt = 0;
  /** Storage fell behind: we told the sender to pause. Separate from manualPauseActive so the two reasons compose via OR instead of fighting each other. */
  private backpressureActive = false;
  /** The user explicitly paused the active file via the UI. */
  private manualPauseActive = false;
  private lastDiagnosticsEmitAt = 0;

  // --- Phase-0 pipeline instrumentation (see ReceiverPipelineStats) ---
  private statsStartedAt = 0;
  private statsDecodeMs = 0;
  private statsWriteMs = 0;
  private statsHashMs = 0;
  private statsUiMs = 0;
  private lastStatsEmitAt = 0;

  constructor(
    private readonly control: ControlChannel,
    lanes: DataChannel[],
    /** Override point for tests/benchmarking — production default is the protocol constant. Aggregate across all lanes, not per-lane (see plan decision #6: file-level backpressure, not per-lane). */
    private readonly backpressureHighWatermark = RECEIVE_BACKPRESSURE_HIGH_WATERMARK,
    private readonly backpressureLowWatermark = RECEIVE_BACKPRESSURE_LOW_WATERMARK
  ) {
    this.control.onMessage((json) => this.handleControl(json));
    // Every lane feeds the SAME onLaneMessage handler — which lane delivered
    // a chunk is irrelevant; chunks self-describe (fileIndex, byteOffset)
    // and get reassembled by that, not by arrival order. All lanes' chunks
    // are queued onto the SAME chunkQueue promise chain (unchanged
    // serialization primitive) so inserts-into-the-reorder-buffer and
    // writes-out-of-it never run concurrently with each other.
    for (const lane of lanes) {
      lane.onMessage((buffer) => this.onLaneMessage(buffer));
    }
  }

  /**
   * Adds a lane discovered AFTER construction — e.g. an independent
   * RTCPeerConnection-backed secondary lane the sender negotiated mid-
   * session (see peerLane.ts's listenForAnswererPeerLanes). Identical
   * wiring to what the constructor does per-lane; the reorder buffer and
   * write/hash/ack path downstream are already lane-agnostic, so nothing
   * else needs to change.
   */
  addLane(channel: DataChannel): void {
    channel.onMessage((buffer) => this.onLaneMessage(buffer));
  }

  private onLaneMessage(buffer: ArrayBuffer): void {
    this.lastChunkAt = Date.now();
    this.bytesReceivedTotal += buffer.byteLength;
    this.inFlightBytes += buffer.byteLength;
    this.pendingWrites++;
    let backpressureJustEngaged = false;
    if (!this.backpressureActive && this.inFlightBytes >= this.backpressureHighWatermark) {
      this.backpressureActive = true;
      backpressureJustEngaged = true;
      if (this.activeFileIndex !== null) this.sendControl({ type: "pause", fileIndex: this.activeFileIndex });
    }
    // Throttled like everything else per-chunk — but a backpressure
    // state CHANGE is worth seeing immediately in a live debug session,
    // not delayed up to 250ms behind the event that caused it.
    this.emitDiagnostics(backpressureJustEngaged);
    this.chunkQueue = this.chunkQueue.then(() => this.ingestAndDrain(buffer));
  }

  on<K extends keyof ReceiverEvents>(event: K, listener: (payload: ReceiverEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  /**
   * `sinks` should already be created (e.g. via showSaveFilePicker) for any
   * file the caller wants streamed to disk — acquired synchronously within
   * the user gesture that approved the transfer. Any accepted file without
   * a prebuilt sink falls back to a bounded in-memory sink automatically.
   */
  async accept(acceptedIndices: number[], rejectedIndices: number[], sinks: Map<number, FileSink>): Promise<void> {
    const resumeFrom: { fileIndex: number; offset: number }[] = [];
    let incompleteRecords: TransferRecord[] | null = null;

    for (const idx of acceptedIndices) {
      const offered = this.offeredFiles.get(idx);
      if (!offered) continue;

      const providedSink = sinks.get(idx);
      if (providedSink) {
        this.sinks.set(idx, providedSink);
        this.setStatus(idx, "queued");
        continue;
      }

      // Only an OPFS-backed fallback sink supports durable cross-reload
      // resume (see resumeStore.ts) — check for a persisted record BEFORE
      // creating a fresh sink, so a 10 GB file resumes from ~7.4 GB instead
      // of byte 0. Matched by content identity (name+size+lastModified),
      // not transferId — the room is a new one every re-pair.
      if (supportsOpfs) {
        incompleteRecords ??= await listIncompleteTransferRecords().catch(() => []);
        const match = findMatchingRecord(incompleteRecords, offered);
        if (match) {
          try {
            const sink = await reopenOpfsSink(offered.mimeType, match.storageRef, match.bytesWritten);
            this.sinks.set(idx, sink);
            this.durableResumeState.set(idx, { hashState: match.hashState, transferId: match.transferId, storageRef: match.storageRef });
            resumeFrom.push({ fileIndex: idx, offset: match.bytesWritten });
            this.setStatus(idx, "queued");
            continue;
          } catch {
            // The OPFS file itself may be gone/corrupted since the record
            // was written — drop the stale record and fall through to a
            // fresh sink rather than failing the whole accept.
            void deleteTransferRecord(match.transferId, match.fileIndex);
          }
        }
      }

      const { sink, storageRef } = await createFallbackSink(offered.mimeType, offered.name);
      this.sinks.set(idx, sink);
      if (storageRef) this.pendingStorageRefs.set(idx, storageRef);
      this.setStatus(idx, "queued");
    }
    for (const idx of rejectedIndices) this.setStatus(idx, "rejected");
    this.sendControl({
      type: "file-offer-response",
      accepted: acceptedIndices,
      rejected: rejectedIndices,
      resumeFrom: resumeFrom.length > 0 ? resumeFrom : undefined
    });
  }

  pause(fileIndex: number): void {
    this.sendControl({ type: "pause", fileIndex });
    this.setStatus(fileIndex, "paused", (p) => p.status === "transferring");
    if (fileIndex === this.activeFileIndex) this.manualPauseActive = true;
  }

  resume(fileIndex: number): void {
    this.sendControl({ type: "resume", fileIndex });
    this.setStatus(fileIndex, "transferring", (p) => p.status === "paused");
    if (fileIndex === this.activeFileIndex) {
      this.manualPauseActive = false;
      // Storage backpressure may still be asserted even though the user just
      // resumed manually — re-assert pause right behind it so the sender
      // ends up paused (not running), rather than this resume silently
      // undoing an in-progress storage-driven pause.
      if (this.backpressureActive) this.sendControl({ type: "pause", fileIndex });
    }
  }

  cancel(fileIndex: number): void {
    this.sendControl({ type: "cancel", fileIndex, reason: "user" });
    this.setStatus(fileIndex, "cancelled");
    if (this.activeFileIndex === fileIndex) {
      void this.sinks.get(fileIndex)?.abort("cancelled by receiver");
      // A deliberate cancel (not a connection failure) means the user
      // doesn't want this file — unlike abortAll, there's no reason to
      // keep the durable-resume record around for a later resume.
      if (this.activeTransferId) void deleteTransferRecord(this.activeTransferId, fileIndex);
      this.activeFileIndex = null;
      this.activeHasher = null;
      this.activeTransferId = null;
      this.activeStorageRef = null;
    }
  }

  abortAll(message: string): void {
    for (const p of this.progress.values()) {
      if (p.status !== "completed" && p.status !== "rejected") {
        p.status = "failed";
        p.error = message;
      }
    }
    this.emitProgress();
    if (this.activeFileIndex !== null) {
      if (this.activeStorageRef) {
        // Durable-resume-eligible (OPFS): a connection drop is exactly
        // what resume exists for — calling sink.abort() here would
        // DELETE the partial file (see createOpfsSink/reopenOpfsSink),
        // destroying the very data a future resume needs. Leave it as of
        // the last checkpoint and the persisted record stands.
      } else {
        void this.sinks.get(this.activeFileIndex)?.abort(message);
      }
    }
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

  /** Phase 1 fix — see SenderEngine.emitProgressThrottled for the reasoning. Used only on the hot per-chunk path. */
  private lastProgressEmitAt = 0;
  private emitProgressThrottled(): void {
    const now = performance.now();
    if (now - this.lastProgressEmitAt < 100) return;
    this.lastProgressEmitAt = now;
    this.emitProgress();
  }

  /** Throttled (not per-chunk), same reasoning as the sender's equivalent. */
  private maybeEmitPipelineStats(fileIndex: number, bytesReceived: number, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastStatsEmitAt < 250) return;
    this.lastStatsEmitAt = now;
    this.emitter.emit("pipeline-stats", {
      fileIndex,
      bytesReceived,
      elapsedMs: now - this.statsStartedAt,
      decodeMs: this.statsDecodeMs,
      writeMs: this.statsWriteMs,
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
      case "file-offer": {
        for (const f of msg.files) {
          this.offeredFiles.set(f.fileIndex, f);
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
        const suggestedNames = dedupeFilenames(msg.files.map((f) => f.name));
        this.emitter.emit("offer", { files: msg.files, suggestedNames });
        this.emitProgress();
        return;
      }
      case "transfer-start": {
        if (this.activeFileIndex === msg.fileIndex) {
          // The sender is RESUMING this file after a reconnect, from its last
          // confirmed offset — not restarting it. That offset can be slightly
          // behind what we've actually already written (acks are periodic,
          // not per-byte), so the resend may overlap what we have. No
          // explicit skip-counter needed: ingestAndDrain's frontier-relative
          // trim (against activeWrittenBytes, unchanged by this branch)
          // dedupes the overlap per-chunk from each chunk's own byteOffset —
          // the same mechanism that also handles multi-lane out-of-order
          // delivery, so this one case needs no special handling at all.
          this.setStatus(msg.fileIndex, "transferring");
          return;
        }
        this.activeFileIndex = msg.fileIndex;
        // Durable resume (closed/reloaded tab, matched in accept()) seeds a
        // hasher from the persisted hash state instead of starting fresh —
        // msg.resumeFromOffset already carries the right byte offset either
        // way (the sender reports whatever it was actually told to resume
        // from), but only a durable-resume hasher has already "seen" bytes
        // [0, offset) for the final digest to come out correct.
        const durable = this.durableResumeState.get(msg.fileIndex);
        this.activeHasher = new IncrementalHasher(durable?.hashState);
        this.activeTransferId = durable?.transferId ?? (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        this.activeStorageRef = durable?.storageRef ?? this.pendingStorageRefs.get(msg.fileIndex) ?? null;
        this.durableResumeState.delete(msg.fileIndex);
        this.pendingStorageRefs.delete(msg.fileIndex);
        this.activeWrittenBytes = msg.resumeFromOffset;
        this.reorderBuffer.clear();
        this.lastAckAt = Date.now();
        this.lastAckBytes = this.activeWrittenBytes;
        this.inFlightBytes = 0;
        this.pendingWrites = 0;
        this.bytesReceivedTotal = msg.resumeFromOffset;
        this.backpressureActive = false;
        this.manualPauseActive = false;
        this.lastChunkAt = 0;
        this.lastWriteAt = 0;
        this.lastCheckpointOffset = msg.resumeFromOffset;
        this.statsStartedAt = performance.now();
        this.statsDecodeMs = 0;
        this.statsWriteMs = 0;
        this.statsHashMs = 0;
        this.statsUiMs = 0;
        this.lastStatsEmitAt = 0;
        this.setStatus(msg.fileIndex, "transferring");
        return;
      }
      case "file-trailer": {
        void this.finishFile(msg.fileIndex, msg.sha256Hex);
        return;
      }
      case "pause":
        this.setStatus(msg.fileIndex, "paused", (p) => p.status === "transferring");
        return;
      case "resume":
        this.setStatus(msg.fileIndex, "transferring", (p) => p.status === "paused");
        return;
      case "cancel": {
        this.setStatus(msg.fileIndex, "cancelled");
        if (this.activeFileIndex === msg.fileIndex) {
          void this.sinks.get(msg.fileIndex)?.abort(msg.reason);
          // The sender deliberately stopped sending this file (not a
          // connection failure, which goes through abortAll instead) —
          // nothing left to durably resume.
          if (this.activeTransferId) void deleteTransferRecord(this.activeTransferId, msg.fileIndex);
          this.activeFileIndex = null;
          this.activeHasher = null;
          this.activeTransferId = null;
          this.activeStorageRef = null;
        }
        return;
      }
      case "session-complete":
        this.emitter.emit("session-complete", undefined);
        return;
      default:
        return;
    }
  }

  /**
   * Releases one arrived buffer's bytes from the backpressure accounting —
   * called exactly once per original arrival, at the point it's ACTUALLY
   * written (not merely dequeued from the reorder buffer), re-checking
   * whether storage has caught back up enough to tell the sender to
   * resume. Generalizes the old handleChunk's `finally` block to be
   * callable from the drain loop instead of being tied 1:1 to one buffer.
   */
  private releaseInFlight(bytes: number): void {
    this.inFlightBytes = Math.max(0, this.inFlightBytes - bytes);
    this.pendingWrites = Math.max(0, this.pendingWrites - 1);
    let backpressureJustReleased = false;
    if (this.backpressureActive && this.inFlightBytes <= this.backpressureLowWatermark && !this.manualPauseActive) {
      this.backpressureActive = false;
      backpressureJustReleased = true;
      if (this.activeFileIndex !== null) this.sendControl({ type: "resume", fileIndex: this.activeFileIndex });
    }
    this.emitDiagnostics(backpressureJustReleased);
  }

  /**
   * Decodes one arrival, trims it against the current write frontier
   * (`activeWrittenBytes`) — this single frontier-relative trim replaces
   * the old single-lane-only `resumeSkipRemaining` counter, since it's
   * computed fresh from each chunk's own self-describing byteOffset
   * instead of a separately-tracked running counter, which makes it
   * correct for BOTH the original live-reconnect-resend-overlap case AND
   * genuinely out-of-order multi-lane delivery with zero extra state. A
   * chunk entirely behind the frontier is a pure duplicate (dropped); one
   * straddling it is trimmed to its new tail; one entirely ahead of it is
   * stored as-is. Then drains whatever is now contiguous from the
   * frontier into the unchanged sequential write/hash/checkpoint/ack path.
   */
  private async ingestAndDrain(buffer: ArrayBuffer): Promise<void> {
    if (this.activeFileIndex === null) {
      this.releaseInFlight(buffer.byteLength);
      return;
    }
    const { fileIndex, byteOffset, payload: rawPayload } = decodeChunkFrame(buffer);
    if (fileIndex !== this.activeFileIndex) {
      this.releaseInFlight(buffer.byteLength); // sequential-file protocol — defensive only
      return;
    }

    let offset = byteOffset;
    let payload = rawPayload;
    if (offset < this.activeWrittenBytes) {
      const trim = this.activeWrittenBytes - offset;
      if (trim >= payload.byteLength) {
        this.releaseInFlight(buffer.byteLength); // pure duplicate from a resumed resend — already have these bytes
        return;
      }
      payload = payload.subarray(trim);
      offset += trim; // === this.activeWrittenBytes
    }
    if (this.reorderBuffer.has(offset)) {
      this.releaseInFlight(buffer.byteLength); // exact duplicate already queued — defensive only
      return;
    }

    this.reorderBuffer.set(offset, { payload, releaseBytes: buffer.byteLength });
    await this.drainContiguous(fileIndex);
  }

  private async drainContiguous(fileIndex: number): Promise<void> {
    for (;;) {
      const next = this.reorderBuffer.get(this.activeWrittenBytes);
      if (!next) return;
      this.reorderBuffer.delete(this.activeWrittenBytes);
      const ok = await this.writeAndHashChunk(fileIndex, next.payload);
      this.releaseInFlight(next.releaseBytes);
      if (!ok) return; // write failed — writeAndHashChunk already cleared active-file state
    }
  }

  /** The exact same per-chunk write→hash→checkpoint→ack logic the old handleChunk ran inline, now reusable from the drain loop. Returns false on a write failure (active-file state already cleared by the time it returns). */
  private async writeAndHashChunk(fileIndex: number, payload: Uint8Array): Promise<boolean> {
    let tMark = performance.now();
    const sink = this.sinks.get(fileIndex);
    const progress = this.progress.get(fileIndex);
    if (!sink || !progress) return true;
    this.statsDecodeMs += performance.now() - tMark;

    tMark = performance.now();
    try {
      await sink.write(payload);
    } catch (err) {
      // The write failed, but whatever was successfully persisted BEFORE
      // this chunk is still valid and resumable — intentionally not
      // deleting any durable-resume record here, only clearing in-memory
      // active-file state.
      progress.status = "failed";
      progress.error = err instanceof Error ? err.message : "Failed to write file.";
      this.emitProgress();
      this.sendControl({ type: "cancel", fileIndex, reason: "error" });
      this.activeFileIndex = null;
      this.activeHasher = null;
      this.activeTransferId = null;
      this.activeStorageRef = null;
      return false;
    }
    this.statsWriteMs += performance.now() - tMark;

    this.lastWriteAt = Date.now();
    tMark = performance.now();
    await this.activeHasher?.update(payload);
    this.statsHashMs += performance.now() - tMark;
    this.activeWrittenBytes += payload.byteLength;
    progress.bytesMoved = this.activeWrittenBytes;
    progress.confirmedBytes = this.activeWrittenBytes;
    this.emitProgressThrottled();
    this.maybeEmitPipelineStats(fileIndex, this.activeWrittenBytes);
    // Awaited, not fire-and-forget: checkpoint() closes and reopens the
    // underlying OPFS writable, and drainContiguous calls (via chunkQueue)
    // are strictly serialized — if the NEXT chunk's write() ran
    // concurrently with that swap, it could hit the stream mid-close.
    await this.maybePersistTransferRecord(fileIndex);

    const now = Date.now();
    // The final chunk MUST ack unconditionally, bypassing the periodic
    // interval/byte-threshold gate below — otherwise the very last write
    // can fall inside a gap the periodic conditions never trigger for,
    // leaving the sender with no explicit confirmation that the receiver
    // actually has the full file (see sender.ts's matching wait, which
    // this unblocks — without it, that wait could hang forever on a file
    // whose size doesn't happen to align with ACK_BYTE_INTERVAL).
    const expectedSize = this.offeredFiles.get(fileIndex)?.size;
    const isFinalChunk = expectedSize !== undefined && this.activeWrittenBytes >= expectedSize;
    if (isFinalChunk || now - this.lastAckAt >= ACK_INTERVAL_MS || this.activeWrittenBytes - this.lastAckBytes >= ACK_BYTE_INTERVAL) {
      this.sendControl({ type: "chunk-ack", fileIndex, confirmedBytes: this.activeWrittenBytes });
      this.lastAckAt = now;
      this.lastAckBytes = this.activeWrittenBytes;
    }
    return true;
  }

  /** Throttled like emitProgress — a per-chunk debug event at GB-scale throughput is itself exactly the "UI overhead per packet" problem being measured. `force` bypasses the throttle for backpressure state transitions, worth seeing immediately. */
  private emitDiagnostics(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastDiagnosticsEmitAt < 250) return;
    this.lastDiagnosticsEmitAt = now;
    if (this.activeFileIndex === null) return;
    this.emitter.emit("receive-diagnostics", {
      fileIndex: this.activeFileIndex,
      bytesReceived: this.bytesReceivedTotal,
      bytesPersisted: this.activeWrittenBytes,
      inFlightBytes: this.inFlightBytes,
      pendingWrites: this.pendingWrites,
      backpressureActive: this.backpressureActive,
      manualPauseActive: this.manualPauseActive,
      lastChunkAt: this.lastChunkAt,
      lastWriteAt: this.lastWriteAt
    });
  }

  /**
   * Durable resume checkpoint — GEOMETRIC spacing, not fixed-interval.
   * Measured fact: OPFS's `createWritable({keepExistingData: true})`
   * copies the ENTIRE existing file into a new swap area every time it's
   * called — confirmed by direct instrumentation (1.6 ms at 256 KiB
   * written, 153.7 ms at 132 MiB written, scaling linearly with current
   * size, ~1.2 ms/MiB). A FIXED checkpoint interval (e.g. every 8 MiB)
   * means checkpoint COUNT grows linearly with file size while EACH
   * checkpoint's cost ALSO grows linearly with file size — total overhead
   * is quadratic, turning a 256 MiB transfer's checkpoints into multiple
   * seconds of pure overhead and a 10+ GB transfer into minutes.
   *
   * Requiring new data since the last checkpoint to be at least 25% of
   * the position at that checkpoint (geometric growth, 64 MiB floor for
   * early small files) bounds TOTAL checkpoint overhead across a whole
   * transfer to a small constant multiple of ONE checkpoint at the final
   * size — linear in transfer size, not quadratic — at the cost of a
   * larger (~25% of bytes-so-far) worst-case loss window on an abrupt
   * crash. A real fix (FileSystemSyncAccessHandle in a Worker, whose
   * flush() has no such copy cost) would remove this tradeoff entirely;
   * that's a larger architectural change than this pass makes — tracked
   * as a known follow-up, not silently left as unbounded quadratic cost.
   */
  private async maybePersistTransferRecord(fileIndex: number): Promise<void> {
    if (!this.activeStorageRef || !this.activeTransferId || !this.activeHasher) return;
    const sinceLastCheckpoint = this.activeWrittenBytes - this.lastCheckpointOffset;
    const requiredGrowth = Math.max(64 * 1024 * 1024, this.lastCheckpointOffset * 0.25);
    if (sinceLastCheckpoint < requiredGrowth) return;
    const checkpointOffset = this.activeWrittenBytes;
    this.lastCheckpointOffset = checkpointOffset;
    const offered = this.offeredFiles.get(fileIndex);
    const sink = this.sinks.get(fileIndex);
    if (!offered || !sink) return;
    try {
      // Commit the OPFS swap data to the real file FIRST — only once that
      // succeeds does the persisted record's claimed byte offset actually
      // match what's really on disk.
      await sink.checkpoint?.(checkpointOffset);
      const hashState = await this.activeHasher.save();
      await saveTransferRecord({
        transferId: this.activeTransferId,
        fileIndex,
        name: offered.name,
        size: offered.size,
        mimeType: offered.mimeType,
        lastModified: offered.lastModified,
        bytesWritten: checkpointOffset,
        chunkSize: 0, // informational only on this path — the receiver doesn't choose chunk size, the sender does
        storageMechanism: "opfs",
        storageRef: this.activeStorageRef,
        hashState,
        updatedAt: Date.now()
      });
    } catch {
      /* best-effort checkpoint — a failed save just means a slightly larger re-send window on the next resume, not a correctness issue */
    }
  }

  private async finishFile(fileIndex: number, senderSha256Hex: string): Promise<void> {
    // file-trailer arrives on the CONTROL channel, which has no ordering
    // guarantee relative to the DATA channel's own in-flight chunks — the
    // same race already fixed on the sender side (waitForBufferedAmountZero)
    // exists here too. Without this, the trailer can be processed before
    // the last chunk's write() has actually finished, hashing/reconstructing
    // an incomplete file. Waiting for the queue drains it first.
    //
    // NOTE (N=2 multi-lane integrity investigation): this only guards
    // against an ALREADY-ARRIVED chunk still sitting unprocessed in
    // chunkQueue — it cannot wait for a chunk that hasn't arrived on the
    // wire AT ALL yet (still crossing a slower, independent lane). That gap
    // is what sender.ts's waitForFullConfirmation closes: the sender now
    // withholds file-trailer until the receiver's own chunk-ack reports the
    // full size, so this method is never entered before the last chunk —
    // wherever it is — has actually arrived and been written.
    await this.chunkQueue;
    const sink = this.sinks.get(fileIndex);
    const progress = this.progress.get(fileIndex);
    const hasher = this.activeHasher;
    if (!sink || !progress) return;

    const computedHex = hasher ? await hasher.digestHex() : "";
    const ok = computedHex === senderSha256Hex;

    try {
      await sink.close();
    } catch {
      /* best-effort close */
    }

    progress.status = ok ? "completed" : "failed";
    if (!ok) progress.error = "Integrity check failed — the received file didn't match.";
    this.emitProgress();
    this.sendControl({ type: "file-complete", fileIndex, ok, sha256Hex: computedHex });

    if (ok) {
      const memSink = "toBlobAsync" in sink ? (sink as MemorySink) : null;
      const blob = memSink ? await memSink.toBlobAsync() : null;
      this.emitter.emit("file-ready", { fileIndex, name: progress.name, blob });
    }

    // The sender has sent its last byte either way (ok or integrity
    // failure) — there's nothing left to durably resume from this point,
    // successful or not.
    if (this.activeTransferId) void deleteTransferRecord(this.activeTransferId, fileIndex);

    this.activeFileIndex = null;
    this.activeHasher = null;
    this.activeWrittenBytes = 0;
    this.activeTransferId = null;
    this.activeStorageRef = null;
  }
}
