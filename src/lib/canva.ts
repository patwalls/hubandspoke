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
  /** Optional image fields. Each value is a Canva-hosted asset_id obtained
   *  by uploading via {@link uploadCanvaAssetFromBuffer} and polling
   *  {@link fetchCanvaAssetUpload} until success. Empty/omitted = no
   *  image fields are sent. Canva ignores unknown keys, but if the
   *  template has any IMAGE-typed tagged field that we DON'T send, the
   *  autofill response keeps that element at its default placeholder
   *  (same as text fields). */
  imageAssetIds?: Record<string, string>;
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
  type AutofillValue =
    | { type: "text"; text: string }
    | { type: "image"; asset_id: string };
  const data: Record<string, AutofillValue> = {};
  for (const [name, value] of Object.entries(args.textFields)) {
    data[name] = { type: "text", text: value };
  }
  for (const [name, assetId] of Object.entries(args.imageAssetIds ?? {})) {
    data[name] = { type: "image", asset_id: assetId };
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

/**
 * Upload image bytes to Canva and return a job id. The Canva Autofill API
 * only accepts image fields that reference an asset already in the Canva
 * account — external image URLs are not supported in autofill payloads
 * directly. So the flow is: upload bytes → poll until success → use the
 * returned asset id in the autofill `data` block.
 *
 * Bytes are PUT to /v1/asset-uploads with a base64'd filename in the
 * Asset-Upload-Metadata header. The endpoint is async — caller polls
 * via {@link fetchCanvaAssetUpload}.
 */
export async function uploadCanvaAssetFromBuffer(args: {
  /** Raw image bytes. Canva accepts jpg/jpeg/png/heic/webp/svg/gif/tiff. */
  bytes: Uint8Array | Buffer;
  /** Filename used in the Canva asset-library row (cosmetic). */
  fileName: string;
}): Promise<{ jobId: string }> {
  const accessToken = await getCanvaAccessToken();
  const nameB64 = Buffer.from(args.fileName, "utf8").toString("base64");
  const res = await fetch(`${BASE_URL}/v1/asset-uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Asset-Upload-Metadata": JSON.stringify({ name_base64: nameB64 }),
    },
    // Cast to BodyInit-compatible: fetch in Node 18+ accepts Buffer / Uint8Array.
    body: args.bytes as unknown as BodyInit,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave json null; raw body is in `text`
  }
  if (!res.ok) {
    type ErrJson = { message?: string; error?: string; code?: string };
    const j = json as ErrJson | null;
    const detail =
      (j && (j.message || j.error || j.code)) ||
      text.slice(0, 300) ||
      `HTTP ${res.status}`;
    throw new Error(
      `Canva asset-uploads create failed (HTTP ${res.status}): ${detail}`,
    );
  }
  type CreateAssetResp = { job?: { id?: string } };
  const jobId = (json as CreateAssetResp | null)?.job?.id;
  if (!jobId) {
    throw new Error(
      `Canva asset-uploads response had no job.id — ${text.slice(0, 300)}`,
    );
  }
  return { jobId };
}

export interface CanvaAssetUploadResult {
  status: "in_progress" | "success" | "failed";
  assetId?: string;
  errorMessage?: string;
}

export async function fetchCanvaAssetUpload(
  jobId: string,
): Promise<CanvaAssetUploadResult> {
  const accessToken = await getCanvaAccessToken();
  const res = await fetch(`${BASE_URL}/v1/asset-uploads/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`Canva asset-uploads/${jobId} fetch failed: ${detail}`);
  }
  type AssetUploadJob = {
    job?: {
      status?: "in_progress" | "success" | "failed";
      asset?: { id?: string };
      error?: { message?: string };
    };
  };
  const job = (json as AssetUploadJob | null)?.job;
  if (!job?.status) {
    throw new Error(
      `Canva asset-uploads/${jobId} response had no job.status — ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  if (job.status === "success") {
    return { status: "success", assetId: job.asset?.id };
  }
  if (job.status === "failed") {
    return { status: "failed", errorMessage: job.error?.message };
  }
  return { status: "in_progress" };
}

/**
 * Convenience wrapper: upload bytes, poll until success, return the asset id.
 * Used by `canva-create-copy` to attach a pillar poster as the hero_image
 * field on the brand template. Throws if the upload doesn't settle within
 * `timeoutMs` (default 60s — image uploads typically finish in 2-5s).
 */
export async function uploadCanvaAssetAndWait(args: {
  bytes: Uint8Array | Buffer;
  fileName: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ assetId: string }> {
  const { jobId } = await uploadCanvaAssetFromBuffer(args);
  const deadline = Date.now() + (args.timeoutMs ?? 60_000);
  const interval = args.pollIntervalMs ?? 2000;
  while (Date.now() < deadline) {
    const result = await fetchCanvaAssetUpload(jobId);
    if (result.status === "success") {
      if (!result.assetId) {
        throw new Error(
          `Canva asset-uploads/${jobId} succeeded with no asset.id`,
        );
      }
      return { assetId: result.assetId };
    }
    if (result.status === "failed") {
      throw new Error(
        `Canva asset-uploads/${jobId} failed: ${result.errorMessage ?? "unknown"}`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `Canva asset-uploads/${jobId} did not finish within ${args.timeoutMs ?? 60_000}ms`,
  );
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
