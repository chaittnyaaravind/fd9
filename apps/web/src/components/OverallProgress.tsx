import { useMemo, useRef } from "react";
import type { FileProgress } from "../lib/transfer/types.js";
import { formatBytes, formatEta, formatSpeed, SpeedTracker } from "../lib/format.js";
import { supportsOpfs } from "../lib/transfer/sinks.js";

interface Props {
  files: FileProgress[];
}

/** Best-effort only — the Network Information API is Chrome/Edge-only and not a web standard; omitted entirely rather than guessed where unavailable (e.g. Safari, Firefox). */
function describeNetworkType(): string | null {
  const conn = (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection;
  if (!conn) return null;
  return conn.type ?? conn.effectiveType ?? null;
}

export function OverallProgress({ files }: Props) {
  const trackerRef = useRef<SpeedTracker>();
  if (!trackerRef.current) trackerRef.current = new SpeedTracker();
  const startRef = useRef<{ t: number; bytes: number } | null>(null);
  const peakRef = useRef(0);

  const { totalBytes, confirmedBytes, speed, avgSpeed, peakSpeed } = useMemo(() => {
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const confirmedBytes = files.reduce((sum, f) => sum + f.confirmedBytes, 0);
    const speed = trackerRef.current!.sample(confirmedBytes);
    if (speed > peakRef.current) peakRef.current = speed;

    if (!startRef.current && confirmedBytes > 0) startRef.current = { t: Date.now(), bytes: 0 };
    const start = startRef.current;
    const elapsedSec = start ? (Date.now() - start.t) / 1000 : 0;
    const avgSpeed = start && elapsedSec > 0 ? (confirmedBytes - start.bytes) / elapsedSec : 0;

    return { totalBytes, confirmedBytes, speed, avgSpeed, peakSpeed: peakRef.current };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  if (totalBytes === 0) return null;
  const pct = Math.min(100, Math.round((confirmedBytes / totalBytes) * 100));
  const networkType = describeNetworkType();
  const remaining = totalBytes - confirmedBytes;

  return (
    <div className="overall" aria-live="off">
      <span>
        <strong>{formatBytes(confirmedBytes)}</strong> / {formatBytes(totalBytes)} · {pct}% · Remaining {formatBytes(remaining)}
      </span>
      <span>
        {formatSpeed(speed)} now · {formatSpeed(avgSpeed)} avg · {formatSpeed(peakSpeed)} peak · ETA {formatEta(remaining, speed || avgSpeed)}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: "0.8125rem" }}>
        {networkType ? `Network: ${networkType} · ` : ""}
        Resume: {supportsOpfs ? "enabled" : "unavailable in this browser"}
      </span>
    </div>
  );
}
