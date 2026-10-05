import { createSHA256, type IHasher } from "hash-wasm";

/**
 * Streaming SHA-256 backed by hash-wasm's WASM implementation, not pure JS.
 * Phase-0 of the throughput audit measured pure-JS SHA-256 (@noble/hashes)
 * at ~270-410 MB/s and accounting for ~74% of total pipeline wall-clock
 * time in a 64 MiB benchmark transfer — the dominant bottleneck, confirmed
 * by measurement rather than assumed. WASM SHA-256 is materially faster
 * (typically several hundred MB/s to multiple GB/s depending on the
 * engine), while keeping the exact same incremental, chunk-at-a-time API —
 * neither sender nor receiver ever need the whole file in memory just to
 * compute a digest.
 *
 * The WASM module loads asynchronously; the constructor kicks that off
 * immediately and every call awaits the same promise, so callers don't
 * need to change how/when they construct this — only `update()`/
 * `digestHex()` became async (both call sites were already inside async
 * functions).
 */
export class IncrementalHasher {
  private readonly hasherPromise: Promise<IHasher>;

  /**
   * `initialState` resumes a hash from a prior `save()` snapshot (durable
   * resume across a closed/reloaded tab — see resumeStore.ts) instead of
   * starting fresh, so a 10 GB file's resumed digest doesn't require
   * re-hashing the whole file from byte 0.
   */
  constructor(initialState?: Uint8Array) {
    this.hasherPromise = createSHA256().then((h) => {
      h.init();
      if (initialState) h.load(initialState);
      return h;
    });
  }

  async update(chunk: Uint8Array): Promise<void> {
    const hasher = await this.hasherPromise;
    hasher.update(chunk);
  }

  async digestHex(): Promise<string> {
    const hasher = await this.hasherPromise;
    return hasher.digest("hex");
  }

  /** Snapshot the current hash state for later resumption — see the `initialState` constructor param. Must not be called after digestHex(). */
  async save(): Promise<Uint8Array> {
    const hasher = await this.hasherPromise;
    return hasher.save();
  }
}
