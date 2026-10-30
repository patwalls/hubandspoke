/**
 * Per-principal fixed-window rate limit for the public API. In-memory on
 * purpose: the app runs one web dyno, the API is internal, and a limiter
 * that resets on deploy is fine. If web ever scales past one dyno this
 * becomes advisory — move the counter to Postgres or Redis then.
 */
export const RATE_LIMIT_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

interface Bucket {
  windowStart: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window resets. */
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private readonly limit = RATE_LIMIT_PER_MINUTE,
    private readonly windowMs = WINDOW_MS,
  ) {}

  hit(key: string, now: number = Date.now()): RateLimitResult {
    let b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.windowMs) {
      b = { windowStart: now, count: 0 };
      this.buckets.set(key, b);
      // Opportunistic sweep so a long-lived process doesn't hoard dead keys.
      if (this.buckets.size > 10_000) this.sweep(now);
    }
    b.count += 1;
    const resetAt = Math.ceil((b.windowStart + this.windowMs) / 1000);
    return {
      allowed: b.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - b.count),
      resetAt,
    };
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) {
      if (now - b.windowStart >= this.windowMs) this.buckets.delete(k);
    }
  }
}

export const apiRateLimiter = new RateLimiter();

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(r.limit),
    "X-RateLimit-Remaining": String(r.remaining),
    "X-RateLimit-Reset": String(r.resetAt),
  };
}
