import type { FileProgress } from "../lib/transfer/types.js";
import { formatBytes } from "../lib/format.js";
import { SuccessBurst } from "./SuccessBurst.js";

interface Props {
  files: FileProgress[];
  onPause: (fileIndex: number) => void;
  onResume: (fileIndex: number) => void;
  onCancel: (fileIndex: number) => void;
}

export function FileQueue({ files, onPause, onResume, onCancel }: Props) {
  if (files.length === 0) return null;
  return (
    <ul className="file-queue" aria-label="Files in this session">
      {files.map((f) => {
        const pct = f.size > 0 ? Math.min(100, Math.round((f.confirmedBytes / f.size) * 100)) : f.status === "completed" ? 100 : 0;
        const active = f.status === "transferring" || f.status === "paused";
        return (
          <li className="file-row" key={f.fileIndex}>
            <div className="file-row-top">
              <div className="file-meta">
                <div className="file-name" title={f.name}>
                  {f.name}
                </div>
                <div className="file-sub">
                  {formatBytes(f.size)} · {f.mimeType || "unknown type"}
                </div>
              </div>
              <span className={`file-status ${f.status}`}>{f.status}</span>
              <SuccessBurst fire={f.status === "completed"} />
            </div>
            <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            {f.error ? <div className="error-text">{f.error}</div> : null}
            {active ? (
              <div className="file-row-controls">
                {f.status === "transferring" ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => onPause(f.fileIndex)}>
                    Pause
                  </button>
                ) : (
                  <button className="btn btn-secondary btn-sm" onClick={() => onResume(f.fileIndex)}>
                    Resume
                  </button>
                )}
                <button className="btn btn-danger btn-sm" onClick={() => onCancel(f.fileIndex)}>
                  Cancel
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
