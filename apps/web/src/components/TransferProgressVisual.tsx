import { useMemo, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { FileProgress } from "../lib/transfer/types.js";
import type { LinkQuality } from "../lib/rtc.js";
import { formatSpeed, SpeedTracker } from "../lib/format.js";
import { IconDownload, IconUpload } from "./icons.js";

interface Props {
  files: FileProgress[];
  /** Same three-state evidence rtc.ts produces — "unknown" must never be shown as "Direct." */
  quality: LinkQuality;
}

function qualityLabel(quality: LinkQuality): string {
  if (quality === "direct") return "Direct connection";
  if (quality === "relayed") return "Relayed connection";
  return "Confirming route…";
}

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

/**
 * The live, in-progress counterpart to the hero's TransferVisual — same
 * devices-and-flowing-packets language, but driven by real numbers: the
 * ring fill is actual confirmed-byte percentage, the packet flow speed is
 * derived from actual measured throughput (clamped to a readable animation
 * range, never implying a literal 1:1 packets-per-second count), and the
 * speed readout is the same SpeedTracker-based figure OverallProgress
 * shows. Nothing here is decorative-only; it's the same evidence, drawn.
 */
export function TransferProgressVisual({ files, quality }: Props) {
  const reduceMotion = useReducedMotion();
  const trackerRef = useRef<SpeedTracker>();
  if (!trackerRef.current) trackerRef.current = new SpeedTracker();

  const { pct, speed } = useMemo(() => {
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const confirmedBytes = files.reduce((sum, f) => sum + f.confirmedBytes, 0);
    const sampledSpeed = trackerRef.current!.sample(confirmedBytes);
    const sampledPct = totalBytes > 0 ? Math.min(100, (confirmedBytes / totalBytes) * 100) : 0;
    return { pct: sampledPct, speed: sampledSpeed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  if (files.length === 0) return null;

  const flowDuration = speed > 0 ? Math.max(0.6, Math.min(2.4, 60_000_000 / speed)) : 1.8;

  return (
    <div className="progress-visual">
      <div className="tv-device" aria-hidden="true">
        <IconUpload width={22} height={22} />
      </div>
      <div className="pv-link-wrap" aria-hidden="true">
        <div className="tv-link">
          {!reduceMotion ? (
            <>
              <span className="tv-packet p1" style={{ animationDuration: `${flowDuration}s` }} />
              <span className="tv-packet p2" style={{ animationDuration: `${flowDuration}s` }} />
              <span className="tv-packet p3" style={{ animationDuration: `${flowDuration}s` }} />
            </>
          ) : null}
        </div>
        <div className="pv-ring-badge">
          <svg width="56" height="56" viewBox="0 0 56 56">
            <circle className="pv-ring-track" cx="28" cy="28" r={RING_R} />
            <motion.circle
              className="pv-ring-fill"
              cx="28"
              cy="28"
              r={RING_R}
              strokeDasharray={RING_C}
              initial={false}
              animate={{ strokeDashoffset: RING_C - (pct / 100) * RING_C }}
              transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 110, damping: 22 }}
            />
          </svg>
          <span className="pv-ring-pct">{Math.round(pct)}%</span>
        </div>
      </div>
      <div className="tv-device tv-device-b" aria-hidden="true">
        <IconDownload width={22} height={22} />
      </div>
      <div className="pv-readout">
        <strong>{formatSpeed(speed)}</strong>
        <span>{qualityLabel(quality)}</span>
      </div>
    </div>
  );
}
