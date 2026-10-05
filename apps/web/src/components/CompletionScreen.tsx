import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { IconCheck } from "./icons.js";
import type { ReadyFile } from "../state/session.js";

interface Props {
  role: "sender" | "receiver";
  readyFiles: ReadyFile[];
  onStartOver: () => void;
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

export function CompletionScreen({ role, readyFiles, onStartOver }: Props) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="completion">
      <motion.div
        className="badge"
        aria-hidden="true"
        initial={reduceMotion ? { opacity: 0 } : { scale: 0, opacity: 0 }}
        animate={reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1 }}
        transition={reduceMotion ? { duration: 0.15 } : { type: "spring", stiffness: 300, damping: 18 }}
      >
        <IconCheck width={28} height={28} />
      </motion.div>
      <h2>{role === "sender" ? "Files sent" : "Files received"}</h2>
      <p style={{ color: "var(--text-muted)" }}>
        {role === "sender"
          ? "The other device has confirmed every file arrived intact."
          : "Every file was verified byte-for-byte against the sender's copy."}
      </p>
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
