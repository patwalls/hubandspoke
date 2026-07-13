/**
 * HTTP client for Pulse (pulse.walls.sh) — Pat's self-hosted, residential-IP
 * social metrics API. Pulse is the free-but-best-effort metrics source; the
 * ScrapeCreators API remains the paid-but-reliable fallback. See
 * `metrics-provider.ts` for the Pulse-first / SC-fallback composition — no
 * caller should hit this module directly for metric refreshes.
 *
 * DARK until `PULSE_METRICS_ENABLED=1` is set (see `pulseMetricsEnabled`).
 */

const PULSE_BASE = (process.env.PULSE_API_URL || "https://pulse.walls.sh").replace(/\/$/, "");

// Threads/LinkedIn reads are headless-browser renders on Pulse's side and can
// take ~10-15s; the worker dyno has no router timeout so a patient budget is
// fine. Failing fast here would just burn an SC credit we didn't need to.
const PULSE_TIMEOUT_MS = Math.max(
  5_000,
  parseInt(process.env.PULSE_TIMEOUT_MS || "25000", 10)
);

/** Master switch for the Pulse-first metrics path. Unset/anything-else → every
 *  metric refresh goes straight to ScrapeCreators exactly as before. */
export function pulseMetricsEnabled(): boolean {
  const v = (process.env.PULSE_METRICS_ENABLED || "").toLowerCase();
  return v === "1" || v === "true";
}

/** Normalized response of Pulse `GET /metrics?url=…` (see pulse src/metrics.ts). */
export interface PulsePostMetrics {
  url: string;
  platform: string;
  contentId: string;
  postType: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  quotes: number | null;
  bookmarks: number | null;
  viewsEstimated: boolean;
  commentsEstimated: boolean;
  publishedAt: string | null;
  title: string | null;
  author: string | null;
  thumbnail: string | null;
  fetchedAt: string;
}

export class PulseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null
  ) {
    super(message);
    this.name = "PulseError";
  }
}

/**
 * Fetch normalized post metrics from Pulse. Returns the parsed metrics on 2xx,
 * `null` when Pulse says the post itself is gone (`content_unavailable` —
 * mirrors the SC 404→null convention), and throws `PulseError` on everything
 * else (login_required, rate_limited, fetch_failed, network) so the provider
 * can fall back to ScrapeCreators.
 */
export async function pulseFetchMetrics(postUrl: string): Promise<PulsePostMetrics | null> {
  const url = `${PULSE_BASE}/metrics?url=${encodeURIComponent(postUrl)}`;
  const headers: HeadersInit = process.env.PULSE_API_TOKEN
    ? { authorization: `Bearer ${process.env.PULSE_API_TOKEN}` }
    : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(PULSE_TIMEOUT_MS) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through — a non-JSON body on a non-2xx is covered below
  }
  const errBody = body as { error?: string; detail?: string } | null;
  if (res.ok && body) return body as PulsePostMetrics;
  if (errBody?.error === "content_unavailable") return null;
  throw new PulseError(
    `Pulse /metrics ${res.status}: ${errBody?.error || "?"} ${errBody?.detail || ""}`.trim(),
    res.status,
    errBody?.error ?? null
  );
}
