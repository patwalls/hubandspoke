/**
 * Scrape Creators account-level fetchers. Pulls channel/profile metadata
 * (display name, avatar, bio, followers/following/posts/views, verified
 * flag, banner, location) for seeded accounts. Runs on demand from the
 * settings UI and on a weekly cron via `src/jobs/tasks/account-refresh.ts`.
 *
 * Endpoint paths were confirmed by probing SC directly — see the table
 * below. The earlier version of this module had wrong paths for X,
 * TikTok, Threads, and LinkedIn; every 404 there is fixed.
 *
 *   YouTube    GET /v1/youtube/channel?handle=@<handle>
 *   Instagram  GET /v1/instagram/profile?handle=<handle>
 *   X          GET /v1/twitter/profile?handle=<handle>
 *   TikTok     GET /v1/tiktok/profile?handle=<handle>
 *   Threads    GET /v1/threads/profile?handle=<handle>
 *   LinkedIn   GET /v1/linkedin/profile?url=<.../in/<handle>>    (personal)
 *              GET /v1/linkedin/company?url=<.../company/<handle>> (company page)
 *
 * Partial writes: only columns with a non-null SC value get updated.
 * Avoids wiping a previously-refreshed follower count when a transient
 * endpoint failure returns half a payload.
 */
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { getAccountById } from "@/lib/db/accounts";

interface AccountRefreshResult {
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  followerCount?: number | null;
  followingCount?: number | null;
  postCount?: number | null;
  totalViews?: number | null;
  verified?: boolean | null;
  bannerUrl?: string | null;
  location?: string | null;
  externalId?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ─── Per-platform fetchers ────────────────────────────────────────────────

async function fetchYouTubeChannel(handle: string): Promise<AccountRefreshResult | null> {
  // SC accepts `@handle` or a full URL; we normalize to `@handle` since
  // that's how the account.handle column stores it.
  const h = handle.startsWith("@") ? handle : `@${handle}`;
  const json = await scFetchJson<Record<string, unknown>>("/v1/youtube/channel", { handle: h });
  if (!json) return null;
  // `avatar.image.sources[0].url` / `banner[0].url` — defensive walk.
  const avatarUrl = pickString(json, ["avatar.image.sources.0.url", "avatar.url"]);
  const bannerUrl = pickString(json, ["banner.0.url", "banner.image.sources.0.url"]);
  return {
    displayName: (json.name as string | undefined) ?? null,
    avatarUrl,
    bio: (json.description as string | undefined) ?? null,
    followerCount: pickInt(json, ["subscriberCount"]),
    postCount: pickInt(json, ["videoCount"]),
    totalViews: pickInt(json, ["viewCount"]),
    verified: pickBool(json, ["isVerified"]),
    bannerUrl,
    externalId: (json.channelId as string | undefined) ?? null,
    url: (json.channel as string | undefined) ?? null,
    metadata: json,
  };
}

async function fetchInstagramProfile(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<{ data?: { user?: Record<string, unknown> } } & Record<string, unknown>>(
    "/v1/instagram/profile",
    { handle }
  );
  if (!json) return null;
  const user = (json.data?.user ?? json) as Record<string, unknown>;
  return {
    displayName: (user.full_name as string | undefined) ?? (user.username as string | undefined) ?? null,
    avatarUrl: (user.profile_pic_url_hd as string | undefined) ?? (user.profile_pic_url as string | undefined) ?? null,
    bio: (user.biography as string | undefined) ?? null,
    followerCount: pickInt(user, ["edge_followed_by.count", "follower_count"]),
    followingCount: pickInt(user, ["edge_follow.count", "following_count"]),
    // IG doesn't expose a `post_count` directly, but `edge_owner_to_timeline_media.count` is the total feed post count.
    postCount: pickInt(user, ["edge_owner_to_timeline_media.count", "media_count"]),
    verified: pickBool(user, ["is_verified"]),
    externalId: (user.fbid as string | undefined) ?? (user.id as string | undefined) ?? null,
    url: `https://www.instagram.com/${handle}`,
    metadata: json,
  };
}

async function fetchXUser(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/twitter/profile", { handle });
  if (!json) return null;
  const core = (json.core ?? {}) as Record<string, unknown>;
  const legacy = (json.legacy ?? {}) as Record<string, unknown>;
  const locWrap = (json.location ?? {}) as Record<string, unknown>;
  return {
    displayName: (core.name as string | undefined) ?? (legacy.name as string | undefined) ?? null,
    avatarUrl: pickString(json, ["avatar.image_url"]) ?? (legacy.profile_image_url_https as string | undefined) ?? null,
    bio: (legacy.description as string | undefined) ?? null,
    followerCount: pickInt(legacy, ["followers_count"]),
    followingCount: pickInt(legacy, ["friends_count"]),
    postCount: pickInt(legacy, ["statuses_count"]),
    verified: pickBool(json, ["is_blue_verified"]),
    bannerUrl: (legacy.profile_banner_url as string | undefined) ?? null,
    location: (locWrap.location as string | undefined) ?? (legacy.location as string | undefined) ?? null,
    externalId: (json.id as string | undefined) ?? (json.rest_id as string | undefined) ?? null,
    url: `https://x.com/${handle}`,
    metadata: json,
  };
}

async function fetchTikTokUser(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/tiktok/profile", { handle });
  if (!json) return null;
  const user = (json.user ?? {}) as Record<string, unknown>;
  const stats = (json.stats ?? json.statsV2 ?? {}) as Record<string, unknown>;
  return {
    displayName: (user.nickname as string | undefined) ?? (user.uniqueId as string | undefined) ?? null,
    avatarUrl:
      (user.avatarLarger as string | undefined) ??
      (user.avatarMedium as string | undefined) ??
      (user.avatarThumb as string | undefined) ??
      null,
    bio: (user.signature as string | undefined) ?? null,
    followerCount: pickInt(stats, ["followerCount"]),
    followingCount: pickInt(stats, ["followingCount"]),
    postCount: pickInt(stats, ["videoCount"]),
    // TikTok exposes a "heartCount" (lifetime likes across all videos) —
    // closer in spirit to `total_views` than anything else we have for
    // other platforms. Keeping it in metadata for now; don't mis-label.
    verified: pickBool(user, ["verified"]),
    externalId: (user.id as string | undefined) ?? (user.secUid as string | undefined) ?? null,
    url: `https://www.tiktok.com/@${handle}`,
    metadata: json,
  };
}

async function fetchLinkedin(
  handle: string,
  storedUrl: string | null
): Promise<AccountRefreshResult | null> {
  // LinkedIn has two account kinds — personal profiles (linkedin.com/in/…)
  // and company pages (linkedin.com/company/…) — served by different SC
  // endpoints. Route by the stored URL when we have one; otherwise probe
  // /in/ first and fall back to /company/ on miss.
  const kind = storedUrl?.includes("/company/")
    ? "company"
    : storedUrl?.includes("/in/")
      ? "personal"
      : null;

  if (kind === "company") {
    return fetchLinkedinCompany(storedUrl!);
  }
  if (kind === "personal") {
    return fetchLinkedinPersonal(storedUrl!);
  }
  const personal = await fetchLinkedinPersonal(`https://www.linkedin.com/in/${handle}`);
  if (personal) return personal;
  return fetchLinkedinCompany(`https://www.linkedin.com/company/${handle}`);
}

async function fetchLinkedinPersonal(url: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/linkedin/profile", { url });
  // SC returns HTTP 404 → null on non-personal / private profiles;
  // scFetchJson already collapses that. But defensively drop payloads
  // that come back without a `name` (seen on private accounts).
  if (!json || typeof json.name !== "string") return null;
  return {
    displayName: json.name,
    avatarUrl: (json.image as string | undefined) ?? null,
    bio: (json.about as string | undefined) ?? (json.headline as string | undefined) ?? null,
    followerCount: pickInt(json, ["followers"]),
    // `connections` is LinkedIn's separate concept (mutual). Closest to
    // "following_count" semantically for a personal profile.
    followingCount: pickInt(json, ["connections"]),
    location: (json.location as string | undefined) ?? null,
    url,
    metadata: json,
  };
}

async function fetchLinkedinCompany(url: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/linkedin/company", { url });
  if (!json || typeof json.name !== "string") return null;
  const loc = (json.location ?? {}) as Record<string, unknown>;
  const locParts = [loc.city, loc.state, loc.country].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  const location =
    locParts.length > 0
      ? locParts.join(", ")
      : (json.headquarters as string | undefined) ?? null;
  return {
    displayName: json.name,
    avatarUrl: (json.logo as string | undefined) ?? null,
    bio: (json.description as string | undefined) ?? (json.slogan as string | undefined) ?? null,
    followerCount: pickInt(json, ["followers"]),
    bannerUrl: (json.coverImage as string | undefined) ?? null,
    location,
    externalId: (json.id as string | undefined) ?? null,
    url: (json.url as string | undefined) ?? url,
    metadata: json,
  };
}

async function fetchThreadsUser(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/threads/profile", { handle });
  if (!json) return null;
  return {
    displayName: (json.full_name as string | undefined) ?? (json.username as string | undefined) ?? null,
    avatarUrl: (json.profile_pic_url as string | undefined) ?? null,
    bio: (json.biography as string | undefined) ?? null,
    followerCount: pickInt(json, ["follower_count"]),
    totalViews: pickInt(json, ["text_post_app_public_views"]),
    verified: pickBool(json, ["is_verified"]),
    externalId: (json.pk as string | undefined) ?? (json.id as string | undefined) ?? null,
    url: `https://www.threads.net/@${handle}`,
    metadata: json,
  };
}

async function fetchFacebookPage(url: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/facebook/profile", { url });
  if (!json || typeof json.name !== "string") return null;
  return {
    displayName: json.name,
    avatarUrl:
      (json.profilePicLarge as string | undefined) ??
      (json.profilePicMedium as string | undefined) ??
      null,
    bio: (json.pageIntro as string | undefined) ?? null,
    followerCount: pickInt(json, ["followerCount"]),
    externalId:
      (json.id as string | undefined) ??
      pickString(json, ["adLibrary.pageId"]),
    url: (json.url as string | undefined) ?? url,
    metadata: json,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Refresh the given account: fetch SC data for its platform+handle, write
 * back to `accounts`, stamp success / error. Platforms without an SC
 * account endpoint (newsletter, "other") stamp a descriptive error and
 * return so the weekly sweep doesn't retry them every run.
 */
export interface RefreshAccountResult {
  /** Platform on the account (or "skip" for non-SC platforms). */
  platform: string;
  /** SC credits consumed by this run. 0 when the platform has no SC endpoint. */
  credits: number;
  /** True if SC returned data and we wrote it back. */
  ok: boolean;
  /** Human-readable reason when `ok=false` (skip reason or error message). */
  note?: string;
}

export async function refreshAccount(
  accountId: string
): Promise<RefreshAccountResult> {
  const account = await getAccountById(accountId);
  if (!account) throw new Error(`account not found: ${accountId}`);

  const handle = account.handle;
  let result: AccountRefreshResult | null = null;
  let skipMessage: string | null = null;

  try {
    switch (account.platform) {
      case "youtube":
        result = await fetchYouTubeChannel(handle);
        break;
      case "instagram":
        result = await fetchInstagramProfile(handle);
        break;
      case "x":
        result = await fetchXUser(handle);
        break;
      case "tiktok":
        result = await fetchTikTokUser(handle);
        break;
      case "linkedin":
        result = await fetchLinkedin(handle, account.url);
        break;
      case "threads":
        result = await fetchThreadsUser(handle);
        break;
      case "facebook": {
        const fbUrl = account.url ?? `https://www.facebook.com/${handle}`;
        result = await fetchFacebookPage(fbUrl);
        break;
      }
      case "newsletter":
      case "other":
        skipMessage = `Scrape Creators has no account-level endpoint for platform=${account.platform}`;
        break;
      default:
        skipMessage = `Unknown platform: ${account.platform}`;
    }
  } catch (err) {
    const msg =
      err instanceof ScrapeCreatorsError
        ? `${err.status} ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    await db
      .update(accounts)
      .set({
        lastRefreshedAt: new Date(),
        lastRefreshError: msg,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
    return { platform: account.platform, credits: 1, ok: false, note: msg };
  }

  if (skipMessage || !result) {
    await db
      .update(accounts)
      .set({
        lastRefreshedAt: new Date(),
        lastRefreshError: skipMessage ?? "Scrape Creators returned no data",
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
    return {
      platform: account.platform,
      credits: skipMessage ? 0 : 1,
      ok: false,
      note: skipMessage ?? "Scrape Creators returned no data",
    };
  }

  // Partial-update: only overwrite columns SC gave us a value for. Avoids
  // wiping a previously-set follower count if this run happened to miss it.
  const patch: Partial<typeof accounts.$inferInsert> = {
    lastRefreshedAt: new Date(),
    lastRefreshError: null,
    updatedAt: new Date(),
  };
  if (result.displayName != null) patch.displayName = result.displayName;
  if (result.avatarUrl != null) patch.avatarUrl = result.avatarUrl;
  if (result.bio != null) patch.bio = result.bio;
  if (result.followerCount != null) patch.followerCount = result.followerCount;
  if (result.followingCount != null) patch.followingCount = result.followingCount;
  if (result.postCount != null) patch.postCount = result.postCount;
  if (result.totalViews != null) patch.totalViews = result.totalViews;
  if (result.verified != null) patch.verified = result.verified;
  if (result.bannerUrl != null) patch.bannerUrl = result.bannerUrl;
  if (result.location != null) patch.location = result.location;
  if (result.externalId != null) patch.externalId = result.externalId;
  if (result.url != null) patch.url = result.url;
  if (result.metadata) patch.metadata = result.metadata;

  await db.update(accounts).set(patch).where(eq(accounts.id, accountId));
  return { platform: account.platform, credits: 1, ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Walk a dotted path through a JSON-ish object, returning the first
 *  numeric value found. Supports array indices (`path.0.count`). */
function pickInt(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = walk(obj, key);
    if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = walk(obj, key);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickBool(obj: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const v = walk(obj, key);
    if (typeof v === "boolean") return v;
  }
  return null;
}

function walk(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}
