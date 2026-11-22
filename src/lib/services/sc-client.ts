/**
 * Shared HTTP client for the ScrapeCreators API. All SC-touching code should
 * import from here rather than constructing requests inline — that keeps
 * auth, base URL, and error handling consistent across enrichers, decay
 * jobs, and bulk syncs.
 */

export const SC_BASE = "https://api.scrapecreators.com";

function apiKey(): string {
  const key = process.env.SCRAPE_CREATORS_API_KEY;
  if (!key) throw new Error("SCRAPE_CREATORS_API_KEY is not set");
  return key;
}

export function headers(): HeadersInit {
  return { "x-api-key": apiKey() };
}

export class ScrapeCreatorsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string
  ) {
    super(message);
    this.name = "ScrapeCreatorsError";
  }
}

/** ScrapeCreators 5xx is usually a one-off upstream scrape failure: the same
 *  call a second later succeeds. Retry those in-call (issue #139: ~15% of
 *  YouTube syncs died on a single /channel/shorts 500 and waited an hour for
 *  the next sweep). 4xx is a real answer and is never retried. Mutable so
 *  tests can zero the waits. */
export const SC_RETRY_DELAYS_MS = [1_000, 3_000];

/** SC answers a deleted / private / region-blocked post with a 5xx whose body
 *  says so — e.g. `500 {"error":"internal_server_error","message":"This video
 *  is unavailable"}` (HUBANDSPOKE-84). That is a "not found", not an upstream
 *  blip: retrying never helps. Matched on SC's own structured `message` field
 *  (an API error string, not user content), and only when it names the
 *  content — `"Service Unavailable"` is a real transient 503 and still retries. */
const SC_GONE_MESSAGE =
  /^this (video|post|reel|short|tweet|content) (is|has been) (unavailable|private|removed|deleted)\b/i;

export function isScContentGoneBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" && SC_GONE_MESSAGE.test(parsed.message.trim());
  } catch {
    return false;
  }
}

/** GET a SC endpoint with 5xx retries. 2xx → parsed JSON; 404 → null when
 *  `nullOn404`, else an error; any other non-2xx → `ScrapeCreatorsError`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scGetWithRetry<T = any>(
  path: string,
  query: Record<string, string> = {},
  opts: { nullOn404?: boolean } = {}
): Promise<T | null> {
  const qs = new URLSearchParams(query).toString();
  const url = `${SC_BASE}${path}${qs ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: headers() });
    if (res.status === 404 && opts.nullOn404) return null;
    if (res.ok) return (await res.json()) as T;
    const body = await res.text();
    // Content gone, dressed as a 5xx: answer it like the 404 it is — no
    // retries, null for `nullOn404` callers, else a 404-status error that
    // isPermanentEnrichmentError and friends already treat as final.
    if (res.status >= 500 && isScContentGoneBody(body)) {
      if (opts.nullOn404) return null;
      throw new ScrapeCreatorsError(
        `SC ${path} ${res.status} (content gone): ${body.slice(0, 500)}`,
        404,
        path
      );
    }
    if (res.status >= 500 && attempt < SC_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, SC_RETRY_DELAYS_MS[attempt]));
      continue;
    }
    throw new ScrapeCreatorsError(
      `SC ${path} ${res.status}: ${body.slice(0, 500)}`,
      res.status,
      path
    );
  }
}

/**
 * Fetch JSON from a SC endpoint. Returns parsed JSON on 2xx, null on 404 (or
 * a 5xx whose body says the content is gone — see isScContentGoneBody),
 * throws `ScrapeCreatorsError` on other non-2xx (after 5xx retries). Caller
 * decides whether "not found" is fatal — many SC endpoints 404 for deleted
 * posts.
 */
export async function scFetchJson<T>(
  path: string,
  query: Record<string, string> = {}
): Promise<T | null> {
  return scGetWithRetry<T>(path, query, { nullOn404: true });
}
