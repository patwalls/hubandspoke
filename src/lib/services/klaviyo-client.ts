/**
 * Shared HTTP client for the Klaviyo API. All Klaviyo-touching code (campaign
 * sync, newsletter enrichment, performance-decay metrics branch) goes through
 * here so auth, retry, and the JSON:API revision header stay consistent.
 *
 * Auth model: per-account API keys resolved from env. Each newsletter account
 * row carries a `handle` (e.g. "starter-story-newsletter"); we look up
 * `KLAVIYO_API_KEY_<HANDLE_UPPER_SNAKE>` first, fall back to the global
 * `KLAVIYO_API_KEY`. That lets us add HubSpot brands' own Klaviyo accounts
 * later by setting one env var per account, no code change.
 *
 * Revision: pinned to 2025-10-15 — newest stable revision that covers both
 * the Campaigns endpoints and the Reporting (campaign-values-reports)
 * endpoint we need for opens/clicks. Bump deliberately, in lockstep with
 * any payload-shape changes.
 */

export const KLAVIYO_BASE = "https://a.klaviyo.com/api";
export const KLAVIYO_REVISION = "2025-10-15";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

export interface KlaviyoAccountRef {
  /** `accounts.handle` — e.g. "starter-story-newsletter". Used to derive
   *  the per-account env var name. */
  handle: string;
}

export class KlaviyoError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "KlaviyoError";
  }
}

function envVarNameForHandle(handle: string): string {
  // "starter-story-newsletter" → "KLAVIYO_API_KEY_STARTER_STORY_NEWSLETTER"
  const slug = handle
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `KLAVIYO_API_KEY_${slug}`;
}

/**
 * Resolve the API key for a given newsletter account. Tries the per-handle
 * env var first, then the global fallback. Throws with both names so
 * "wait, which env var?" is a 1-line diagnosis.
 */
export function resolveKlaviyoApiKey(account: KlaviyoAccountRef): string {
  const perHandleName = envVarNameForHandle(account.handle);
  const perHandle = process.env[perHandleName];
  if (perHandle) return perHandle;
  const fallback = process.env.KLAVIYO_API_KEY;
  if (fallback) return fallback;
  throw new Error(
    `No Klaviyo API key for handle "${account.handle}". Set ${perHandleName} or KLAVIYO_API_KEY.`,
  );
}

function headersFor(apiKey: string): HeadersInit {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
    Revision: KLAVIYO_REVISION,
  };
}

interface FetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Override the default 30s timeout (e.g. for the long-running reports
   *  endpoint, which can take 5–10s for big lists). */
  timeoutMs?: number;
}

/**
 * Fetch a Klaviyo endpoint and return parsed JSON. Returns null on 404 (the
 * caller decides whether "not found" is fatal — same convention as
 * sc-client). Retries 5xx, 429, and network errors up to 3 attempts with
 * exponential backoff (1s / 2s / 4s); honors `Retry-After` on 429.
 */
export async function fetchKlaviyo<T>(
  account: KlaviyoAccountRef,
  path: string,
  opts: FetchOptions = {},
): Promise<T | null> {
  const apiKey = resolveKlaviyoApiKey(account);
  const url = path.startsWith("http") ? path : `${KLAVIYO_BASE}${path}`;
  const method = opts.method ?? "GET";
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? TIMEOUT_MS,
    );
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: headersFor(apiKey),
        body,
        signal: controller.signal,
      });
    } catch (err) {
      lastErr = err;
      clearTimeout(timeout);
      if (attempt === MAX_ATTEMPTS) {
        throw new KlaviyoError(
          `Klaviyo ${method} ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
          0,
          path,
        );
      }
      await sleep(backoffMs(attempt));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 404) return null;

    if (res.ok) {
      // 204 No Content (rare here but possible for DELETEs)
      if (res.status === 204) return null;
      return (await res.json()) as T;
    }

    // Retryable: 429 + 5xx
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryAfter ?? backoffMs(attempt));
        continue;
      }
    }

    const errBody = await safeReadText(res);
    throw new KlaviyoError(
      `Klaviyo ${method} ${path} ${res.status}: ${errBody.slice(0, 500)}`,
      res.status,
      path,
      errBody,
    );
  }
  // Unreachable — every loop iteration either returns or throws.
  throw lastErr instanceof Error ? lastErr : new Error("Klaviyo: unreachable");
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s — same shape Starter Story's KlaviyoInterface uses.
  return Math.pow(2, attempt - 1) * 1000;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.min(seconds * 1000, 60_000));
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull metrics for a single campaign via the campaign-values-reports
 * endpoint. Returns a lightweight `{ opens, clicks, recipients }` shape
 * matching the columns we care about — `opens` becomes `views` per the
 * user's direction, `clicks` mirrors clicks-from-email, `recipients`
 * is the open-rate denominator.
 *
 * The reporting endpoint REQUIRES a `conversion_metric_id` even when we
 * don't care about conversions — pass any valid metric id for the
 * account (typically "Placed Order"). We surface this as
 * `KLAVIYO_CONVERSION_METRIC_ID` to keep the per-account config in env.
 */
export interface CampaignMetrics {
  opens: number | null;
  clicks: number | null;
  recipients: number | null;
}

interface CampaignValuesReportResponse {
  data?: {
    type: "campaign-values-report";
    attributes?: {
      results?: Array<{
        groupings?: { campaign_id?: string };
        statistics?: Record<string, number>;
      }>;
    };
  };
}

export async function fetchCampaignMetrics(
  account: KlaviyoAccountRef,
  campaignId: string,
): Promise<CampaignMetrics> {
  const conversionMetricId = process.env.KLAVIYO_CONVERSION_METRIC_ID;
  if (!conversionMetricId) {
    throw new Error(
      "KLAVIYO_CONVERSION_METRIC_ID is not set (Klaviyo's reporting API requires a metric id, e.g. 'Placed Order')",
    );
  }
  // "opens" = total opens, "clicks" = total clicks. Klaviyo also exposes
  // `opens_unique` / `clicks_unique`; we pick totals because the user
  // asked for "total opens" → views.
  const body = {
    data: {
      type: "campaign-values-report",
      attributes: {
        statistics: ["opens", "clicks", "recipients"],
        timeframe: { key: "last_365_days" },
        conversion_metric_id: conversionMetricId,
        filter: `equals(campaign_id,"${campaignId}")`,
      },
    },
  };
  const res = await fetchKlaviyo<CampaignValuesReportResponse>(
    account,
    "/campaign-values-reports",
    { method: "POST", body, timeoutMs: 60_000 },
  );
  const stats = res?.data?.attributes?.results?.[0]?.statistics ?? {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    opens: num(stats.opens),
    clicks: num(stats.clicks),
    recipients: num(stats.recipients),
  };
}
