import { createHmac, timingSafeEqual } from "node:crypto";

// Zernio (zernio.com, formerly Late / getlate.dev) — a pre-audited social
// posting aggregator. We "rent" their approved TikTok Content Posting API
// client, so we never submit our own TikTok developer app for audit. Mirrors
// the thin-fetch-wrapper shape of `src/lib/typefully.ts`.
//
// v1 uses Zernio ONLY for TikTok, and ONLY in draft/inbox mode
// (`tiktokSettings.draft: true`) — we deliver the video to the creator's
// TikTok inbox and a human finishes the post in the TikTok app.

const BASE_URL = "https://zernio.com/api/v1";

// Don't let a slow Zernio media-fetch hold a web request open past Heroku's
// 30s router limit. The create-post call itself is fast (Zernio fetches the
// media asynchronously), but be defensive.
const DEFAULT_TIMEOUT_MS = 20_000;

function authHeader(): string {
  const token = process.env.ZERNIO_API_KEY;
  if (!token) throw new Error("ZERNIO_API_KEY not set");
  return `Bearer ${token}`;
}

/** The Zernio profile (organizational container) connected accounts live
 *  under. One workspace for v1, so this is a single env value. */
export function zernioProfileId(): string {
  const id = process.env.ZERNIO_PROFILE_ID;
  if (!id) throw new Error("ZERNIO_PROFILE_ID not set");
  return id;
}

async function zernioFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
        ...(rest.headers ?? {}),
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Zernio ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  clearTimeout(timer);
  const json = (await res.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!res.ok) {
    const msg =
      (json &&
        ((json.message as string) ||
          (json.error as string) ||
          (json.detail as string))) ||
      `HTTP ${res.status}`;
    throw new Error(`Zernio ${path} failed: ${msg}`);
  }
  return json;
}

// ── Account connection ────────────────────────────────────────────────────

/**
 * Get the OAuth authorization URL for connecting a `platform` account under
 * our profile. Redirect the user to the returned `authUrl`; Zernio runs the
 * OAuth dance and (standard mode) redirects back to `redirectUrl` with
 * `?connected=<platform>&accountId=<id>&username=<handle>` appended.
 *
 * NOTE: the docs render this field as both `authUrl` and `url` across pages —
 * read either defensively.
 */
export async function getConnectUrl(args: {
  platform: string;
  redirectUrl: string;
  profileId?: string;
}): Promise<string> {
  const q = new URLSearchParams({
    profileId: args.profileId ?? zernioProfileId(),
    redirect_url: args.redirectUrl,
  });
  const json = (await zernioFetch(
    `/connect/${encodeURIComponent(args.platform)}?${q.toString()}`,
    { method: "GET" },
  )) as { authUrl?: string; url?: string } | null;
  const url = json?.authUrl ?? json?.url;
  if (!url) throw new Error("Zernio getConnectUrl: no authUrl in response");
  return url;
}

export interface ZernioAccount {
  /** ConnectedAccount `_id` — the value passed as `accountId` when posting. */
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  isActive?: boolean;
}

/** List connected accounts, optionally filtered by platform. Used as the
 *  belt-and-suspenders fallback when the OAuth callback doesn't echo the
 *  new accountId. */
export async function listAccounts(args?: {
  platform?: string;
  profileId?: string;
}): Promise<ZernioAccount[]> {
  const q = new URLSearchParams({
    profileId: args?.profileId ?? zernioProfileId(),
  });
  if (args?.platform) q.set("platform", args.platform);
  const json = (await zernioFetch(`/accounts?${q.toString()}`, {
    method: "GET",
  })) as { accounts?: ZernioAccount[] } | ZernioAccount[] | null;
  if (Array.isArray(json)) return json;
  return json?.accounts ?? [];
}

export interface ZernioAccountHealth {
  status?: string;
  tokenStatus?: {
    valid?: boolean;
    expiresAt?: string;
    needsRefresh?: boolean;
  };
  issues?: string[];
}

/** Token health for a connected account — drives "reconnect needed" UI. */
export async function getAccountHealth(
  accountId: string,
): Promise<ZernioAccountHealth> {
  const json = (await zernioFetch(
    `/accounts/${encodeURIComponent(accountId)}/health`,
    { method: "GET" },
  )) as ZernioAccountHealth | null;
  return json ?? {};
}

export interface TikTokPrivacyLevel {
  value: string; // PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY
  label: string;
}

export interface TikTokCreatorInfo {
  privacyLevels: TikTokPrivacyLevel[];
  canPostMore: boolean;
  nickname: string | null;
}

/**
 * TikTok creator-info — TikTok requires this be fetched before a direct
 * publish (compliance) and that the chosen `privacyLevel` be one of the
 * returned allowed values. Drives the privacy dropdown in the publish dialog.
 */
export async function getTikTokCreatorInfo(
  accountId: string,
): Promise<TikTokCreatorInfo> {
  const json = (await zernioFetch(
    `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info?mediaType=video`,
    { method: "GET" },
  )) as {
    creator?: { nickname?: string; canPostMore?: boolean };
    privacyLevels?: TikTokPrivacyLevel[];
  } | null;
  return {
    privacyLevels: json?.privacyLevels ?? [
      { value: "PUBLIC_TO_EVERYONE", label: "Public To Everyone" },
    ],
    canPostMore: json?.creator?.canPostMore ?? true,
    nickname: json?.creator?.nickname ?? null,
  };
}

// ── Posting ──────────────────────────────────────────────────────────────

/** Per-platform delivery record on a Zernio post. For an inbox draft,
 *  "delivered to inbox" is terminal from our side — a human takes over. */
export interface ZernioPlatformTarget {
  platform: string;
  status?: string; // pending | publishing | published | failed
  platformPostId?: string | null;
  platformPostUrl?: string | null;
  errorMessage?: string | null;
  errorCategory?: string | null;
}

export interface ZernioPost {
  _id: string;
  status?: string;
  platforms?: ZernioPlatformTarget[];
}

interface CreateTikTokPostArgs {
  /** Zernio ConnectedAccount `_id` for the target TikTok account. */
  accountId: string;
  /** Publicly-fetchable URL to the video (an S3 presigned GET URL works as
   *  long as it returns raw bytes + correct Content-Type and is valid when
   *  Zernio fetches it). */
  videoUrl: string;
  /** Caption — carried through to the live post on a direct publish. */
  caption: string;
  /** One of the creator's allowed values from getTikTokCreatorInfo. */
  privacyLevel: string;
  /** When true, deliver to the TikTok inbox as a draft (a human finishes in
   *  the app) instead of publishing live. Default false = publish now. Kept
   *  so the inbox flow can be re-enabled without another rewrite. */
  draft?: boolean;
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
}

/**
 * Publish a video to TikTok via Zernio (riding their pre-audited Content
 * Posting client). Default is a DIRECT publish — `publishNow: true` posts it
 * live to the profile with the caption + chosen privacy. TikTok mandates the
 * consent flags (`contentPreviewConfirmed` / `expressConsentGiven`) and an
 * allowed `privacyLevel` (fetch via getTikTokCreatorInfo) for direct posts.
 *
 * IMPORTANT: Zernio defaults a post to a Zernio-side draft when none of
 * publishNow / scheduledFor / queuedFromProfile is set — so publishNow MUST
 * be true to actually publish. Scheduling is held in OUR queue (we call this
 * at fire time with publishNow), so we never pass scheduledFor.
 *
 * Pass `draft: true` to route to the creator's TikTok inbox instead (no
 * privacy/consent needed — the human sets those in-app).
 */
export async function createTikTokPost(
  args: CreateTikTokPostArgs,
): Promise<ZernioPost> {
  const tiktokSettings: Record<string, unknown> = args.draft
    ? { draft: true }
    : {
        privacyLevel: args.privacyLevel,
        allowComment: args.allowComment ?? true,
        allowDuet: args.allowDuet ?? false,
        allowStitch: args.allowStitch ?? false,
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
      };
  const body = {
    content: args.caption,
    mediaItems: [{ type: "video", url: args.videoUrl }],
    platforms: [{ platform: "tiktok", accountId: args.accountId }],
    ...(args.draft ? {} : { publishNow: true }),
    tiktokSettings,
  };
  const json = (await zernioFetch(`/posts`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as { post?: ZernioPost } | ZernioPost | null;
  // Response is documented as { message, post }; tolerate a bare post too.
  const post = (json as { post?: ZernioPost })?.post ?? (json as ZernioPost);
  if (!post?._id) throw new Error("Zernio createTikTokPost: no post id");
  return post;
}

/** Pull the per-TikTok delivery target out of a Zernio post (status + live
 *  URL). */
export function tikTokTarget(post: ZernioPost): ZernioPlatformTarget | null {
  return post.platforms?.find((p) => p.platform === "tiktok") ?? null;
}

/** Fetch a post by id — used for the bounded confirmation poll / webhook
 *  cross-check. */
export async function getPost(postId: string): Promise<ZernioPost> {
  const json = (await zernioFetch(`/posts/${encodeURIComponent(postId)}`, {
    method: "GET",
  })) as { post?: ZernioPost } | ZernioPost | null;
  const post = (json as { post?: ZernioPost })?.post ?? (json as ZernioPost);
  if (!post?._id) throw new Error(`Zernio getPost ${postId}: no post`);
  return post;
}

/**
 * Verify Zernio's `X-Zernio-Signature` (HMAC-SHA256) against the raw request
 * body. Mirrors `verifyTypefullySignature`. Returns false on any malformed
 * input rather than throwing.
 *
 * The exact signed-payload recipe isn't firmly documented; this assumes the
 * common `hmac(secret, rawBody)` hex form. VERIFY against a real webhook
 * before trusting it — until then the receiver treats a failed verify as a
 * soft signal, not a hard 401 (see the webhook route).
 */
export function verifyZernioSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  if (!args.signatureHeader) return false;
  const expected = createHmac("sha256", args.secret)
    .update(args.rawBody)
    .digest("hex");
  // Tolerate an optional "sha256=" prefix.
  const got = args.signatureHeader.replace(/^sha256=/, "");
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
