import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rateLimit.js";

describe("RateLimiter", () => {
  it("allows up to the limit within a window", () => {
    const rl = new RateLimiter(3, 1000);
    const now = 0;
    expect(rl.hit("ip", now)).toBe(true);
    expect(rl.hit("ip", now)).toBe(true);
    expect(rl.hit("ip", now)).toBe(true);
    expect(rl.hit("ip", now)).toBe(false);
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.hit("ip", 0)).toBe(true);
    expect(rl.hit("ip", 500)).toBe(false);
    expect(rl.hit("ip", 1001)).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.hit("a", 0)).toBe(true);
    expect(rl.hit("b", 0)).toBe(true);
    expect(rl.hit("a", 0)).toBe(false);
  });
});
