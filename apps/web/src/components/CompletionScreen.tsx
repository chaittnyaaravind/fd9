import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { IconCheck, IconClose } from "./icons.js";
import type { ReadyFile } from "../state/session.js";
import type { FileProgress } from "../lib/transfer/types.js";

interface Props {
  role: "sender" | "receiver";
  readyFiles: ReadyFile[];
  files: FileProgress[];
  onStartOver: () => void;
}

/**
 * The session reaches ConnectionPhase "completed" once every file hits any
 * terminal status — completed, cancelled, OR rejected (see session.ts's
 * allOk check). That's the right session-lifecycle rule, but it means
 * "completed" does NOT mean "every file was verified intact": a cancelled
 * or rejected transfer ends up here too. This reads the real per-file
 * status rather than assuming success, so a cancelled transfer is never
 * reported as byte-verified when it wasn't.
 */
function summarize(files: FileProgress[]): { allVerified: boolean; verifiedCount: number; total: number } {
  const total = files.length;
  const verifiedCount = files.filter((f) => f.status === "completed").length;
  return { allVerified: total > 0 && verifiedCount === total, verifiedCount, total };
}

/**
 * Each row owns its object URL locally. This (rather than a shared
 * "create once" map) is what survives React 18 StrictMode's dev-only
 * mount→cleanup→remount cycle correctly: the second real effect run just
 * creates its own fresh URL and the phantom one gets revoked, with no
 * shared "already created" guard left pointing at a dead URL.
 */
function ReadyRow({ name, blob }: { name: string; blob: Blob | null }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return (
    <li className="ready-row">
      <span>{name}</span>
      {url ? (
        <a className="btn btn-secondary btn-sm" href={url} download={name}>
          Save
        </a>
      ) : (
        <span style={{ color: "var(--text-dim)" }}>Saved to disk</span>
      )}
    </li>
  );
}

export function CompletionScreen({ role, readyFiles, files, onStartOver }: Props) {
  const reduceMotion = useReducedMotion();
  const { allVerified, verifiedCount, total } = summarize(files);

  let heading: string;
  let body: string;
  if (allVerified) {
    heading = role === "sender" ? "Files sent" : "Files received";
    body =
      role === "sender"
        ? "The other device has confirmed every file arrived intact."
        : "Every file was verified byte-for-byte against the sender's copy.";
  } else {
    heading = "Transfer ended";
    body =
      total === 0
        ? "The session ended before any file could complete."
        : verifiedCount === 0
          ? "No files completed — the transfer was cancelled or declined before any file was verified."
          : `${verifiedCount} of ${total} file${total === 1 ? "" : "s"} completed and ${verifiedCount === 1 ? "was" : "were"} verified; the rest was cancelled or declined.`;
  }

  return (
    <div className="completion">
      <motion.div
        className={`badge${allVerified ? "" : " is-partial"}`}
        aria-hidden="true"
        initial={reduceMotion ? { opacity: 0 } : { scale: 0, opacity: 0 }}
        animate={reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1 }}
        transition={reduceMotion ? { duration: 0.15 } : { type: "spring", stiffness: 300, damping: 18 }}
      >
        {allVerified ? <IconCheck width={28} height={28} /> : <IconClose width={24} height={24} />}
      </motion.div>
      <h2>{heading}</h2>
      <p style={{ color: "var(--text-muted)" }}>{body}</p>
      {role === "receiver" && readyFiles.length > 0 ? (
        <ul className="ready-list">
          {readyFiles.map((f) => (
            <ReadyRow key={f.fileIndex} name={f.name} blob={f.blob} />
          ))}
        </ul>
      ) : null}
      <button className="btn btn-primary" onClick={onStartOver}>
        Start a new transfer
      </button>
    </div>
  );
}
