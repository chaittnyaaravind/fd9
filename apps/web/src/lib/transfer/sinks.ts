export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
  /**
   * Commits buffered writes to the real backing file WITHOUT finalizing
   * the sink, so a periodic checkpoint actually lands on disk — not just
   * in a logical "bytesWritten" counter. Needed because
   * FileSystemWritableFileStream (both OPFS and user-picked File System
   * Access handles) buffers every write to a swap location and only
   * atomically commits it on close(): an abandoned stream that's never
   * close()'d (tab killed, connection lost) commits NOTHING, no matter
   * how many bytes were "written" to it. Only implemented where durable
   * resume needs it (OPFS); undefined elsewhere.
   */
  checkpoint?(currentOffset: number): Promise<void>;
}

/**
 * Benchmark-only sink: discards every chunk instead of persisting it. Used
 * to isolate DataChannel/pipeline throughput (stage C) from real
 * persistent-storage write cost (stage E) — running the SAME benchmark
 * transfer once against this and once against a real sink is what tells
 * you how much of total time storage actually accounts for, rather than
 * guessing. Never used for a real transfer.
 */
export function createDiscardSink(): FileSink {
  return {
    async write() {
      /* intentionally discarded — benchmark mode only */
    },
    async close() {},
    async abort() {}
  };
}

export const supportsFileSystemAccess =
  typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";

export const supportsDirectoryPicker =
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

/** Must be called synchronously within a user-gesture handler (e.g. the Accept button's onClick). */
export async function pickSaveHandle(suggestedName: string): Promise<FileSystemFileHandle> {
  if (!window.showSaveFilePicker) throw new Error("File System Access API is not available.");
  return window.showSaveFilePicker({ suggestedName });
}

/** Must also be called within a user gesture. Used when accepting multiple files at once. */
export async function pickDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) throw new Error("Directory picker is not available.");
  return window.showDirectoryPicker({ mode: "readwrite" });
}

export async function sinkFromFileHandle(handle: FileSystemFileHandle): Promise<FileSink> {
  const writable = await handle.createWritable();
  return {
    async write(chunk) {
      await writable.write(chunk);
    },
    async close() {
      await writable.close();
    },
    async abort(reason) {
      await writable.abort(reason).catch(() => undefined);
    }
  };
}

export async function sinkInDirectory(dir: FileSystemDirectoryHandle, name: string): Promise<FileSink> {
  const handle = await dir.getFileHandle(name, { create: true });
  return sinkFromFileHandle(handle);
}

export interface MemorySink extends FileSink {
  /** @deprecated kept only so existing call sites typecheck; prefer toBlobAsync — see below for why. */
  toBlob(): Blob;
  /** Builds the final Blob from however the sink actually stored bytes — synchronous for the plain in-memory sink, a real async reconstruction for the IndexedDB-backed one. */
  toBlobAsync(): Promise<Blob>;
}

/**
 * Bounded in-memory fallback — last resort, used only when IndexedDB itself
 * is unavailable (effectively never in a real browser; this exists mainly
 * so unit tests running under Node, which has no IndexedDB, still work).
 * Throws once the cap is exceeded rather than silently accumulating an
 * unbounded Blob — see MEMORY_FALLBACK_MAX_BYTES.
 */
export function createMemorySink(mimeType: string, maxBytes: number): MemorySink {
  const parts: Uint8Array[] = [];
  let total = 0;

  function toBlob(): Blob {
    return new Blob(parts as BlobPart[], { type: mimeType });
  }

  return {
    async write(chunk) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        parts.length = 0;
        throw new Error(
          `This file exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB limit this browser can hold in memory. Use Chrome or Edge for larger files.`
        );
      }
      parts.push(chunk);
    },
    async close() {
      /* nothing to flush */
    },
    async abort() {
      parts.length = 0;
    },
    toBlob,
    async toBlobAsync() {
      return toBlob();
    }
  };
}

export const supportsIndexedDb = typeof indexedDB !== "undefined";

export const supportsOpfs = typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";

/**
 * Best-effort cleanup of OPFS files left behind by a session that crashed
 * or was closed before a transfer finished (so `abort()`/`toBlobAsync()`
 * never ran to remove them). Runs opportunistically whenever a new OPFS
 * sink is created — never blocks the current transfer, never throws.
 * Files are named `fd9-recv-<epoch-ms>-...`, so age is just the embedded
 * timestamp; anything older than a day is almost certainly orphaned.
 */
async function sweepStaleOpfsFiles(root: FileSystemDirectoryHandle): Promise<void> {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const match = /^fd9-recv-(\d+)-/.exec(name);
      if (match && Number(match[1]) < cutoff) {
        await root.removeEntry(name).catch(() => undefined);
      }
    }
  } catch {
    /* best-effort only */
  }
}

/**
 * Receiver-side fallback preferred over IndexedDB when available (Safari
 * 16.4+, Firefox 111+, and Chrome/Edge when the user didn't go through
 * showSaveFilePicker): OPFS file handles expose the EXACT SAME
 * `createWritable()` streaming-write interface as a user-picked File
 * System Access handle (see sinkFromFileHandle above) — real OS-backed
 * sequential writes, no JS-side accumulation, no 4 MiB-batch-then-put
 * transaction dance. Completion is correspondingly cheaper too:
 * `fileHandle.getFile()` returns a real `File` backed directly by the
 * OPFS data — no Blob-of-Blobs reconstruction loop needed at all, unlike
 * the IndexedDB path.
 *
 * IMPORTANT: `createWritable()` buffers every write to a swap location and
 * only atomically commits it to the real file on `close()` — an abandoned
 * stream (tab killed, connection lost) that's never close()'d commits
 * NOTHING, regardless of how many bytes were "written" to it. `checkpoint()`
 * exists specifically so durable resume's periodic progress checkpoints
 * actually land on disk, not just in a logical byte counter — see
 * receiver.ts's maybePersistTransferRecord, which calls this right after
 * persisting the matching metadata record.
 */
export interface OpfsSinkHandle {
  sink: MemorySink;
  /** The OPFS filename — persist this (see resumeStore.ts) to reopen the SAME partial file later via reopenOpfsSink, instead of starting over. */
  storageRef: string;
}

async function makeOpfsSink(fileHandle: FileSystemFileHandle, root: FileSystemDirectoryHandle, storageRef: string, initialSeek: number): Promise<MemorySink> {
  let writable = await fileHandle.createWritable({ keepExistingData: true });
  if (initialSeek > 0) await writable.write({ type: "seek", position: initialSeek });

  return {
    async write(chunk) {
      await writable.write(chunk);
    },
    async close() {
      await writable.close();
    },
    async abort(reason) {
      await writable.abort(reason).catch(() => undefined);
      await root.removeEntry(storageRef).catch(() => undefined);
    },
    async checkpoint(currentOffset) {
      await writable.close(); // commits everything written so far to the real OPFS file
      writable = await fileHandle.createWritable({ keepExistingData: true });
      await writable.write({ type: "seek", position: currentOffset });
    },
    toBlob() {
      throw new Error("OPFS sink: use toBlobAsync(), not the synchronous toBlob().");
    },
    async toBlobAsync() {
      // Intentionally NOT removing the OPFS entry here — some engines may
      // invalidate an already-returned File's bytes once its backing OPFS
      // entry is deleted. The stale-file sweep below reclaims this on the
      // next sink creation instead of risking that race.
      return fileHandle.getFile();
    }
  };
}

export async function createOpfsSink(mimeType: string, suggestedName: string): Promise<OpfsSinkHandle> {
  const root = await navigator.storage.getDirectory();
  void sweepStaleOpfsFiles(root);
  const safeName = suggestedName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  const opfsName = `fd9-recv-${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
  const fileHandle = await root.getFileHandle(opfsName, { create: true });
  return { storageRef: opfsName, sink: await makeOpfsSink(fileHandle, root, opfsName, 0) };
}

/**
 * Durable resume: reopens an OPFS file a PRIOR *checkpoint* already
 * committed `resumeFromOffset` bytes into (see resumeStore.ts), seeking to
 * that exact position before any new writes — so a 10 GB transfer
 * surviving a closed tab resumes from the last checkpoint (e.g. ~7.4 GB),
 * not from 0. `keepExistingData: true` is what stops createWritable() from
 * truncating the file back to empty.
 */
export async function reopenOpfsSink(mimeType: string, storageRef: string, resumeFromOffset: number): Promise<MemorySink> {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(storageRef); // must already exist — no {create: true}
  return makeOpfsSink(fileHandle, root, storageRef, resumeFromOffset);
}

/**
 * Receiver-side fallback for browsers without the File System Access API
 * (Safari/WebKit on every platform — including a "Chrome"-branded browser
 * on iOS, which Apple requires to run on WebKit regardless of branding; also
 * Firefox). Unlike the plain in-memory sink, this one is NOT bounded by a
 * fixed byte cap and does not hold the file in a growing JS array: every
 * incoming chunk is written straight to its own IndexedDB record as it
 * arrives, so JS heap usage per `write()` call stays at "one chunk," not
 * "one chunk times however many have arrived so far." IndexedDB itself is
 * disk-backed and browser-managed, not a JS data structure — this is what
 * makes files larger than available RAM (4 GB+) actually receivable.
 *
 * The one unavoidable cost is at completion: producing a single downloadable
 * Blob means reading the chunks back out and composing them. This is done
 * by incrementally building `new Blob([composite, nextChunk])` rather than
 * `new Blob([...everyChunkAtOnce])` — browsers back Blob-of-Blobs with
 * internal disk-backed storage rather than copying all bytes into one flat
 * buffer, so this does not require holding the whole file in memory at once
 * either, unlike a naive single `new Blob([allChunks])` call would.
 */
export function createIndexedDbSink(mimeType: string): MemorySink {
  const dbName = `fd9-recv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let dbPromise: Promise<IDBDatabase> | null = null;
  let chunkCount = 0;

  function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("chunks");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function putChunk(key: number, chunk: Uint8Array): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put(chunk, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getChunk(key: number): Promise<Uint8Array> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("chunks", "readonly");
      const req = tx.objectStore("chunks").get(key);
      req.onsuccess = () => resolve(req.result as Uint8Array);
      req.onerror = () => reject(req.error);
    });
  }

  async function cleanup(): Promise<void> {
    try {
      (await openDb()).close();
    } catch {
      /* already closed or never opened */
    }
    indexedDB.deleteDatabase(dbName);
  }

  // Batch several incoming chunks into one IndexedDB record instead of one
  // record per DataChannel chunk (256 KiB) — each IndexedDB transaction has
  // real, fixed commit overhead, and thousands of tiny transactions for a
  // multi-GB file measurably slows the receive path. 4 MiB of buffering is
  // still a tiny, bounded amount of JS memory relative to the whole file.
  const FLUSH_BYTES = 4 * 1024 * 1024;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  function concatPending(): Uint8Array {
    if (pending.length === 1) return pending[0];
    const out = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const p of pending) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  }

  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    const combined = concatPending();
    pending = [];
    pendingBytes = 0;
    await putChunk(chunkCount++, combined);
  }

  return {
    async write(chunk) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= FLUSH_BYTES) await flush();
    },
    async close() {
      await flush();
    },
    async abort() {
      pending = [];
      pendingBytes = 0;
      await cleanup();
    },
    toBlob() {
      throw new Error("createIndexedDbSink: use toBlobAsync(), not the synchronous toBlob().");
    },
    async toBlobAsync() {
      await flush(); // in case close() wasn't called on this exact path
      let combined: Blob = new Blob([], { type: mimeType });
      for (let i = 0; i < chunkCount; i++) {
        const chunk = await getChunk(i);
        combined = new Blob([combined, chunk as BlobPart], { type: mimeType });
      }
      void cleanup(); // the Blob above now owns the bytes; the IndexedDB copy is no longer needed
      return combined;
    }
  };
}
