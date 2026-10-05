import { useEffect, useState } from "react";
import type { IncomingOffer } from "../lib/transfer/receiver.js";
import type { FileSink } from "../lib/transfer/sinks.js";
import {
  pickDirectoryHandle,
  pickSaveHandle,
  sinkFromFileHandle,
  sinkInDirectory,
  supportsDirectoryPicker,
  supportsFileSystemAccess
} from "../lib/transfer/sinks.js";
import { formatBytes } from "../lib/format.js";
import { describeStorageMechanism, estimateStorage, isQuotaBoundMechanism, type StorageEstimate } from "../lib/storageEstimate.js";

interface Props {
  offer: IncomingOffer;
  onDecide: (acceptedIndices: number[], rejectedIndices: number[], sinks: Map<number, FileSink>) => void;
}

export function ApprovalDialog({ offer, onDecide }: Props) {
  const [busy, setBusy] = useState(false);
  const totalBytes = offer.files.reduce((sum, f) => sum + f.size, 0);

  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const mechanism = describeStorageMechanism(offer.files.length);
  const quotaBound = isQuotaBoundMechanism(offer.files.length);
  useEffect(() => {
    void estimateStorage().then(setStorage);
  }, []);
  const insufficientStorage = quotaBound && storage !== null && totalBytes > storage.available;

  async function accept() {
    setBusy(true);
    const sinks = new Map<number, FileSink>();
    const allIndices = offer.files.map((f) => f.fileIndex);

    // File System Access pickers must be invoked synchronously within this
    // click handler's user-activation — any failure or unsupported browser
    // just falls through to the engine's automatic in-memory fallback.
    try {
      if (supportsFileSystemAccess && offer.files.length === 1) {
        const handle = await pickSaveHandle(offer.suggestedNames[0]);
        sinks.set(offer.files[0].fileIndex, await sinkFromFileHandle(handle));
      } else if (supportsDirectoryPicker && offer.files.length > 1) {
        const dir = await pickDirectoryHandle();
        for (let i = 0; i < offer.files.length; i++) {
          sinks.set(offer.files[i].fileIndex, await sinkInDirectory(dir, offer.suggestedNames[i]));
        }
      }
    } catch {
      sinks.clear(); // user cancelled the picker or it failed — memory fallback will cover every file
    }

    onDecide(allIndices, [], sinks);
  }

  function decline() {
    onDecide([], offer.files.map((f) => f.fileIndex), new Map());
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="offer-title">
        <h2 id="offer-title">Incoming files</h2>
        <p style={{ color: "var(--text-muted)", margin: 0 }}>
          {offer.files.length} file{offer.files.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} total
        </p>
        <ul className="offer-list">
          {offer.files.map((f, i) => (
            <li className="offer-row" key={f.fileIndex}>
              <span>{offer.suggestedNames[i]}</span>
              <span>{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
        <p className="storage-preflight" style={{ color: "var(--text-muted)", fontSize: "0.875rem", margin: 0 }}>
          Storage: {mechanism}
          {storage ? ` · ${formatBytes(storage.available)} available, ${formatBytes(storage.quota)} total` : quotaBound ? " · (can't estimate available space in this browser)" : " · not quota-limited (streams to a location you choose)"}
        </p>
        {insufficientStorage ? (
          <p className="storage-warning" role="alert" style={{ color: "var(--danger, #c0392b)", fontWeight: 600, margin: 0 }}>
            Not enough space: this needs {formatBytes(totalBytes)} but only {formatBytes(storage!.available)} is available. The transfer will likely fail partway through.
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={decline} disabled={busy}>
            Decline
          </button>
          <button className="btn btn-primary" onClick={accept} disabled={busy}>
            {busy ? "Preparing…" : insufficientStorage ? "Accept anyway" : "Accept"}
          </button>
        </div>
      </div>
    </div>
  );
}
