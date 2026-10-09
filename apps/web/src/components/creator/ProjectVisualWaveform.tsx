import type { CSSProperties } from "react";

const BAR_COUNT = 24;
// Fixed per-bar peak heights (not random-per-render) so the CSS animation is
// deterministic and never autoplays anything resembling real audio playback
// — a rhythm-like ambient visual, not a claim of audio-reactivity.
const PEAKS = Array.from({ length: BAR_COUNT }, (_, i) => 30 + Math.round(55 * Math.abs(Math.sin(i * 0.7))));

export function ProjectVisualWaveform() {
  return (
    <div className="pv-waveform" aria-hidden="true">
      {PEAKS.map((peak, i) => (
        <span
          key={i}
          className="pv-waveform-bar"
          style={{ "--peak": `${peak}%`, animationDelay: `${(i % 8) * 90}ms` } as CSSProperties}
        />
      ))}
    </div>
  );
}
