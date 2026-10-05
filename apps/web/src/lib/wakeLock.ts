export const supportsWakeLock = typeof navigator !== "undefined" && "wakeLock" in navigator;

/**
 * Re-acquires the wake lock on visibility change, since the browser releases
 * it automatically whenever the tab is hidden (switching apps, locking the
 * phone) — this keeps it held as long as the tab is actually foregrounded.
 */
export class WakeLockController {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private onLossHandlers = new Set<() => void>();

  constructor() {
    document.addEventListener("visibilitychange", () => {
      if (this.wanted && document.visibilityState === "visible") void this.acquire();
    });
  }

  onLoss(handler: () => void): () => void {
    this.onLossHandlers.add(handler);
    return () => this.onLossHandlers.delete(handler);
  }

  async acquire(): Promise<boolean> {
    if (!supportsWakeLock) return false;
    this.wanted = true;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => {
        this.sentinel = null;
        if (this.wanted) for (const h of this.onLossHandlers) h();
      });
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    await this.sentinel?.release().catch(() => undefined);
    this.sentinel = null;
  }
}
