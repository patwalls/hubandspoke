import { describe, expect, it } from "vitest";
import { RateLimiter, rateLimitHeaders } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit in a window, then refuses, then resets", () => {
    const rl = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(rl.hit("k", t0).allowed).toBe(true);
    expect(rl.hit("k", t0 + 1).allowed).toBe(true);
    const third = rl.hit("k", t0 + 2);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = rl.hit("k", t0 + 3);
    expect(fourth.allowed).toBe(false);
    expect(fourth.resetAt).toBe(Math.ceil((t0 + 60_000) / 1000));
    expect(rl.hit("k", t0 + 60_000).allowed).toBe(true);
  });
  it("keys are independent", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.hit("a", 0).allowed).toBe(true);
    expect(rl.hit("b", 0).allowed).toBe(true);
    expect(rl.hit("a", 1).allowed).toBe(false);
  });
  it("emits the standard headers", () => {
    expect(rateLimitHeaders({ allowed: true, limit: 120, remaining: 7, resetAt: 99 })).toEqual({
      "X-RateLimit-Limit": "120",
      "X-RateLimit-Remaining": "7",
      "X-RateLimit-Reset": "99",
    });
  });
});
