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

/**
 * Fetch JSON from a SC endpoint. Returns parsed JSON on 2xx, null on 404,
 * throws `ScrapeCreatorsError` on other non-2xx. Caller decides whether
 * "not found" is fatal — many SC endpoints 404 for deleted posts.
 */
export async function scFetchJson<T>(
  path: string,
  query: Record<string, string> = {}
): Promise<T | null> {
  const qs = new URLSearchParams(query).toString();
  const url = `${SC_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new ScrapeCreatorsError(
      `SC ${path} ${res.status}: ${body.slice(0, 500)}`,
      res.status,
      path
    );
  }
  return (await res.json()) as T;
}
