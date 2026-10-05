const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exp;
  return `${exp === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${UNITS[exp]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(remainingBytes: number, bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  const seconds = remainingBytes / bytesPerSecond;
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

/** Simple sliding-window speed estimator fed a running total of confirmed bytes. */
export class SpeedTracker {
  private samples: { t: number; bytes: number }[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 4000) {
    this.windowMs = windowMs;
  }

  sample(totalBytes: number, now = Date.now()): number {
    this.samples.push({ t: now, bytes: totalBytes });
    while (this.samples.length > 1 && now - this.samples[0].t > this.windowMs) this.samples.shift();
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.bytes - first.bytes) / dt;
  }
}
