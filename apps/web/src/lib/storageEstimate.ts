import { supportsFileSystemAccess, supportsIndexedDb, supportsOpfs } from "./transfer/sinks.js";

export interface StorageEstimate {
  usage: number;
  quota: number;
  available: number;
}

/**
 * `navigator.storage.estimate()` reports the ORIGIN's private storage
 * budget (IndexedDB/OPFS/CacheStorage combined) — not free disk space at
 * an arbitrary OS path. It's only a meaningful pre-flight signal for the
 * OPFS/IndexedDB fallback paths; a File System Access transfer streams to
 * a user-chosen location on the real filesystem, which this API knows
 * nothing about. Returns null where the API isn't available at all
 * (Safari before 16.4, some older browsers) — callers should treat that as
 * "can't say", not "zero available".
 */
export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function") return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof quota !== "number") return null;
    const used = usage ?? 0;
    return { usage: used, quota, available: Math.max(0, quota - used) };
  } catch {
    return null;
  }
}

/** Human-readable name of whichever storage mechanism will actually receive these bytes, given file count and browser capability — matches the preference order in receiver.ts/sinks.ts. */
export function describeStorageMechanism(fileCount: number): string {
  if (supportsFileSystemAccess && fileCount === 1) return "File System Access (direct to disk)";
  if (fileCount > 1 && typeof window !== "undefined" && typeof window.showDirectoryPicker === "function") {
    return "File System Access (direct to disk)";
  }
  if (supportsOpfs) return "OPFS (private persistent storage)";
  if (supportsIndexedDb) return "IndexedDB";
  return "In-memory (bounded)";
}

/** True when the active mechanism (for this file count, in this browser) is bound by the origin's storage.estimate() quota — i.e. NOT streaming to an arbitrary user-chosen disk location. */
export function isQuotaBoundMechanism(fileCount: number): boolean {
  const mech = describeStorageMechanism(fileCount);
  return mech === "OPFS (private persistent storage)" || mech === "IndexedDB";
}
