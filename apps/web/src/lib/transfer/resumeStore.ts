/**
 * Durable transfer-progress records, surviving a closed/reloaded tab — the
 * gap the in-session reconnect path (sender.ts's restartCurrent, receiver's
 * transfer-start resumeFromOffset) doesn't cover, since that lives entirely
 * in JS memory. One IndexedDB database, one small object store, keyed by
 * `transferId:fileIndex` — intentionally separate from the file-bytes
 * storage itself (OPFS/IndexedDB chunk store): this is pure metadata, a
 * few hundred bytes per record, not file content.
 *
 * `transferId` is the room id at offer time — not a cryptographic
 * identity, just a grouping key. Matching a resumable record against a
 * fresh offer (after re-pairing into a NEW room) is done by name+size
 * (+lastModified when present), not transferId, since the room itself is
 * ephemeral and a new one is expected after a reload.
 */

const DB_NAME = "fd9-resume-store";
const STORE_NAME = "transfers";

export interface TransferRecord {
  transferId: string;
  fileIndex: number;
  name: string;
  size: number;
  mimeType: string;
  lastModified?: number;
  bytesWritten: number;
  chunkSize: number;
  storageMechanism: "opfs";
  storageRef: string;
  /** hash-wasm IHasher.save() snapshot — resumes the digest without re-hashing from byte 0. */
  hashState: Uint8Array;
  updatedAt: number;
}

function recordKey(transferId: string, fileIndex: number): string {
  return `${transferId}:${fileIndex}`;
}

/**
 * Node/vitest has no `indexedDB` global at all — every exported function
 * below no-ops rather than throwing a ReferenceError when it's missing,
 * same as supportsIndexedDb elsewhere in sinks.ts. Durable resume is an
 * enhancement layered on top of OPFS; its own absence must never be fatal.
 */
const hasIndexedDb = typeof indexedDB !== "undefined";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTransferRecord(record: TransferRecord): Promise<void> {
  if (!hasIndexedDb) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ ...record, key: recordKey(record.transferId, record.fileIndex) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function deleteTransferRecord(transferId: string, fileIndex: number): Promise<void> {
  if (!hasIndexedDb) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(recordKey(transferId, fileIndex));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listIncompleteTransferRecords(): Promise<TransferRecord[]> {
  if (!hasIndexedDb) return [];
  const db = await openDb();
  const records = await new Promise<TransferRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as TransferRecord[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return records;
}

/** Finds a persisted record matching an offered file by content identity (name+size+lastModified), not by transferId — the room changes every re-pair, the file doesn't. */
export function findMatchingRecord(
  records: TransferRecord[],
  offered: { name: string; size: number; lastModified?: number }
): TransferRecord | null {
  return (
    records.find(
      (r) => r.name === offered.name && r.size === offered.size && (offered.lastModified === undefined || r.lastModified === offered.lastModified)
    ) ?? null
  );
}
