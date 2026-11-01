/**
 * Failed-login throttle (S-168). Counts FAILED sign-ins per email and per
 * client IP in a sliding window; past the limit, sign-in is refused without
 * even checking the password until the window clears. A successful sign-in
 * clears that email's count.
 *
 * In-memory on purpose, like the API rate limiter (src/lib/api/rate-limit.ts):
 * one web dyno, and a counter that resets on deploy still caps guessing at a
 * few dozen tries per 15 minutes instead of thousands. Scale web past one
 * dyno → move this to Postgres.
 *
 * The same class throttles forgot-password sends (per email and per IP), so
 * the reset form can't be used to spam an inbox.
 */
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILS_PER_EMAIL = 10;
export const LOGIN_MAX_FAILS_PER_IP = 50;

export class FailureThrottle {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  private live(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until this key may try again; 0 = not blocked. */
  blockedFor(key: string, now: number = Date.now()): number {
    const list = this.live(key, now);
    if (list.length < this.limit) return 0;
    return Math.ceil((list[list.length - this.limit] + this.windowMs - now) / 1000);
  }

  record(key: string, now: number = Date.now()): void {
    const list = this.live(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) for (const k of [...this.hits.keys()]) this.live(k, now);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

export const loginFailuresByEmail = new FailureThrottle(LOGIN_MAX_FAILS_PER_EMAIL, LOGIN_WINDOW_MS);
export const loginFailuresByIp = new FailureThrottle(LOGIN_MAX_FAILS_PER_IP, LOGIN_WINDOW_MS);

/** Forgot-password: 5 sends per email and 20 per IP an hour. */
export const resetSendsByEmail = new FailureThrottle(5, 60 * 60_000);
export const resetSendsByIp = new FailureThrottle(20, 60 * 60_000);

/**
 * The client's IP. The app sits behind Cloudflare (proxied zone) and then
 * the Heroku router: Cloudflare sets `cf-connecting-ip`; Heroku appends the
 * connecting address to `x-forwarded-for`, so its LAST entry is the one a
 * client can't forge. Falls back to "unknown" (one shared bucket — the
 * per-email limit still holds).
 */
export function clientIp(headers: Headers | undefined | null): string {
  const cf = headers?.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = headers?.get("x-forwarded-for");
  const last = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last || "unknown";
}

/** The per-IP bucket only means something for a real client address. Local
 *  dev / e2e runs come from loopback (or carry no IP), and sharing one bucket
 *  there would lock the e2e login after a few runs; the per-email limit still
 *  applies to them. */
export function ipThrottleKey(ip: string): string | null {
  if (ip === "unknown" || ip === "::1" || /^(::ffff:)?127\./.test(ip)) return null;
  return ip;
}
