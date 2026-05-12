import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { canvaOauth } from "@/lib/db/schema";

const BASE_URL = "https://api.canva.com/rest";

// Canva's autofill jobs are scoped to a singleton OAuth identity for us —
// we authenticate as one Canva account, not per-brand or per-user. The row
// id is constant so the upsert pattern stays simple.
const SINGLETON_ID = "default";

// Advisory-lock key used to serialize concurrent refresh-token exchanges.
// Canva rotates the refresh token on every exchange and immediately
// invalidates the old one; two simultaneous refreshes would race and one
// would end up with a dead token. Postgres accepts an int8 for the
// advisory-lock arg; we keep this in JS-safe int range (well below
// Number.MAX_SAFE_INTEGER) so we don't need bigint literals.
const REFRESH_LOCK_KEY = 634_187_048_112_099;

// Treat the access token as expired this far ahead of its actual expiry,
// so we never present a token that dies mid-request.
const REFRESH_SLACK_MS = 60_000;

interface OauthTokens {
  access_token: string;
  refresh_token: string;
  /** Seconds until expiry; Canva returns ~3600. */
  expires_in: number;
}

/**
 * Get a valid Canva Connect access token. Refreshes from the rotating
 * refresh token stored in `canva_oauth` if the cached access token is
 * expired or missing. Safe to call from concurrent workers — refresh is
 * serialized via a Postgres advisory lock so the rotating RT doesn't get
 * race-invalidated.
 *
 * First-run bootstrap: if no canva_oauth row exists, seeds the table from
 * the CANVA_REFRESH_TOKEN env var (which is what `scripts/canva-oauth.mjs`
 * prints). After bootstrap the env var becomes a dead fallback — the DB row
 * is authoritative because Canva rotates the RT on every exchange.
 */
export async function getCanvaAccessToken(): Promise<string> {
  const row = await loadOauthRow();
  if (
    row?.accessToken &&
    row.accessTokenExpiresAt &&
    row.accessTokenExpiresAt.getTime() > Date.now() + REFRESH_SLACK_MS
  ) {
    return row.accessToken;
  }
  return refreshAndStoreAccessToken();
}

async function refreshAndStoreAccessToken(): Promise<string> {
  return db.transaction(async (tx) => {
    // pg_advisory_xact_lock auto-releases at end of transaction — no manual
    // unlock needed, and a process crash mid-refresh doesn't leak the lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REFRESH_LOCK_KEY})`);

    // Re-check inside the lock: another worker may have refreshed while we
    // waited. Skip the network call in that case so we don't unnecessarily
    // burn through refresh tokens.
    const [row] = await tx
      .select()
      .from(canvaOauth)
      .where(eq(canvaOauth.id, SINGLETON_ID))
      .limit(1);
    if (
      row?.accessToken &&
      row.accessTokenExpiresAt &&
      row.accessTokenExpiresAt.getTime() > Date.now() + REFRESH_SLACK_MS
    ) {
      return row.accessToken;
    }

    const currentRefreshToken =
      row?.refreshToken ?? process.env.CANVA_REFRESH_TOKEN ?? null;
    if (!currentRefreshToken) {
      throw new Error(
        "No Canva refresh token (canva_oauth.refresh_token is empty and CANVA_REFRESH_TOKEN is unset). Run `node --env-file=.env.local scripts/canva-oauth.mjs` to mint one.",
      );
    }

    const tokens = await exchangeRefreshToken(currentRefreshToken);
    const expiresAt = new Date(
      Date.now() + Math.max(0, (tokens.expires_in - 30) * 1000),
    );
    await tx
      .insert(canvaOauth)
      .values({
        id: SINGLETON_ID,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: canvaOauth.id,
        set: {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      });

    return tokens.access_token;
  });
}

async function loadOauthRow() {
  const [row] = await db
    .select()
    .from(canvaOauth)
    .where(eq(canvaOauth.id, SINGLETON_ID))
    .limit(1);
  return row ?? null;
}

async function exchangeRefreshToken(refreshToken: string): Promise<OauthTokens> {
  const clientId = process.env.CANVA_CLIENT_ID;
  const clientSecret = process.env.CANVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("CANVA_CLIENT_ID and CANVA_CLIENT_SECRET must be set.");
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(`${BASE_URL}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (json && (json.error_description || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Canva oauth/token failed: ${detail}`);
  }
  return json as OauthTokens;
}

export interface CreateAutofillArgs {
  brandTemplateId: string;
  title: string;
  /** Plain key→string map of every text field tagged on the brand template.
   *  Canva rejects autofill if any tagged field is missing from `data`. */
  textFields: Record<string, string>;
}

/**
 * Create an autofill job against a Canva Brand Template. Returns a job id;
 * caller polls {@link fetchCanvaAutofillJob} until it succeeds.
 *
 * Canva quirks worth knowing:
 *   - Empty `data:{}` is rejected with "No matching fields in dataset" if
 *     the template has any autofill-tagged fields. We always send a value
 *     for every field the caller hands us.
 *   - Field NAMES must match the tags the template author set in Canva
 *     (e.g. `hook`, `stack_list`, `cta`). Unknown keys are ignored silently.
 */
export async function createCanvaAutofill(
  args: CreateAutofillArgs,
): Promise<{ jobId: string }> {
  const accessToken = await getCanvaAccessToken();
  const data: Record<string, { type: "text"; text: string }> = {};
  for (const [name, value] of Object.entries(args.textFields)) {
    data[name] = { type: "text", text: value };
  }
  const res = await fetch(`${BASE_URL}/v1/autofills`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      brand_template_id: args.brandTemplateId,
      title: args.title,
      data,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Canva autofills create failed: ${detail}`);
  }
  type CreateAutofillResp = { job?: { id?: string } };
  const jobId = (json as CreateAutofillResp | null)?.job?.id;
  if (!jobId) {
    throw new Error(
      `Canva autofills response had no job.id — ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return { jobId };
}

export interface CanvaAutofillJobResult {
  status: "in_progress" | "success" | "failed";
  designId?: string;
  editUrl?: string;
  pageCount?: number;
  errorMessage?: string;
}

export interface CreateExportArgs {
  designId: string;
  /** Format type. "png" produces one URL per page. "pdf"/"mp4"/"gif" produce
   *  a single URL. MVP only uses "png" for slideshow archival. */
  type?: "png" | "pdf" | "mp4" | "gif" | "jpg";
  /** Optional 1-indexed page subset. Omit for all pages. */
  pages?: number[];
}

/**
 * Export a Canva design via `POST /v1/exports`. Asynchronous: returns a job
 * id that the caller polls via {@link fetchCanvaExportJob}. PNG exports
 * return one URL per page (a 4-page slideshow → 4 URLs). PDF/MP4/GIF return
 * a single URL.
 *
 * Defaults to PNG because we use this to archive each slide of a slideshow
 * separately into `production_item_media` rows.
 */
export async function createCanvaExport(
  args: CreateExportArgs,
): Promise<{ jobId: string }> {
  const accessToken = await getCanvaAccessToken();
  type ExportFormat = {
    type: "png" | "pdf" | "mp4" | "gif" | "jpg";
    pages?: number[];
  };
  const format: ExportFormat = { type: args.type ?? "png" };
  if (args.pages && args.pages.length > 0) format.pages = args.pages;
  const res = await fetch(`${BASE_URL}/v1/exports`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      design_id: args.designId,
      format,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Canva exports create failed: ${detail}`);
  }
  type CreateExportResp = { job?: { id?: string } };
  const jobId = (json as CreateExportResp | null)?.job?.id;
  if (!jobId) {
    throw new Error(
      `Canva exports response had no job.id — ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return { jobId };
}

export interface CanvaExportJobResult {
  status: "in_progress" | "success" | "failed";
  /** One URL per exported page for PNG exports. Single-entry array for
   *  PDF/MP4/GIF exports. Empty/undefined while status === "in_progress". */
  urls?: string[];
  errorMessage?: string;
}

export async function fetchCanvaExportJob(
  jobId: string,
): Promise<CanvaExportJobResult> {
  const accessToken = await getCanvaAccessToken();
  const res = await fetch(`${BASE_URL}/v1/exports/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Canva exports/${jobId} fetch failed: ${detail}`);
  }
  type ExportJob = {
    job?: {
      status?: "in_progress" | "success" | "failed";
      urls?: string[];
      error?: { message?: string };
    };
  };
  const job = (json as ExportJob | null)?.job;
  if (!job?.status) {
    throw new Error(
      `Canva exports/${jobId} response had no job.status — ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  if (job.status === "success") {
    return { status: "success", urls: job.urls ?? [] };
  }
  if (job.status === "failed") {
    return { status: "failed", errorMessage: job.error?.message };
  }
  return { status: "in_progress" };
}

export async function fetchCanvaAutofillJob(
  jobId: string,
): Promise<CanvaAutofillJobResult> {
  const accessToken = await getCanvaAccessToken();
  const res = await fetch(`${BASE_URL}/v1/autofills/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Canva autofills/${jobId} fetch failed: ${detail}`);
  }
  type AutofillJob = {
    job?: {
      status?: "in_progress" | "success" | "failed";
      result?: {
        design?: {
          id?: string;
          url?: string;
          page_count?: number;
        };
      };
      error?: { message?: string };
    };
  };
  const job = (json as AutofillJob | null)?.job;
  if (!job?.status) {
    throw new Error(
      `Canva autofills/${jobId} response had no job.status — ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  if (job.status === "success") {
    return {
      status: "success",
      designId: job.result?.design?.id,
      editUrl: job.result?.design?.url,
      pageCount: job.result?.design?.page_count,
    };
  }
  if (job.status === "failed") {
    return { status: "failed", errorMessage: job.error?.message };
  }
  return { status: "in_progress" };
}
