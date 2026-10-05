import type { ChunkReadable } from "./types.js";

/**
 * Generates bytes on demand instead of reading a real file — used only by
 * benchmark mode to isolate the data-plane pipeline (framing, backpressure,
 * hashing, DataChannel throughput, storage write) from real disk I/O. A
 * `size` of 50 GiB costs nothing up front: no buffer of that size is ever
 * allocated, each `slice().arrayBuffer()` call allocates only the one
 * chunk being read, exactly like a real file's `Blob.slice()` would.
 *
 * The byte pattern is a deterministic function of absolute offset, not
 * random — so the SAME incremental-SHA-256 integrity check the real
 * transfer path already does on both ends still passes without any
 * special-casing: a benchmark transfer is byte-for-byte reproducible and
 * independently verifiable, not just "didn't crash."
 */
export class SyntheticChunkSource implements ChunkReadable {
  constructor(readonly size: number) {}

  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } {
    const clampedEnd = Math.min(end, this.size);
    const length = Math.max(0, clampedEnd - start);
    const offset = start;
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
          buf[i] = (offset + i) & 0xff;
        }
        return buf.buffer;
      }
    };
  }
}
