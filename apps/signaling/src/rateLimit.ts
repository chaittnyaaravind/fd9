/** Fixed-window counter, good enough for abuse-dampening at this scale. */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns true if this call is allowed; false if the key has exceeded its limit. */
  hit(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  /** Periodic cleanup so the map doesn't grow unbounded with one-off IPs. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
