/**
 * Scrape Creators account-level fetchers. Pulls channel/profile metadata
 * (display name, avatar, bio, follower count, platform-native id) for the
 * accounts we've seeded. Runs on demand from the settings UI and on a
 * weekly cron via `src/jobs/tasks/account-refresh.ts`.
 *
 * Separate from the per-post fetchers in `performance-decay.ts` / the
 * enrichment modules — those hit `/v1/{platform}/post`, this hits
 * `/v1/{platform}/channel` or `/v1/{platform}/profile`.
 *
 * Failure mode: any SC error or 404 is caught, stamped on
 * `accounts.last_refresh_error`, and surfaced in the UI. Partial results
 * (e.g. SC returns display name but not follower count) are persisted as-is.
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
  externalId?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ─── Per-platform fetchers ────────────────────────────────────────────────

async function fetchYouTubeChannel(handle: string): Promise<AccountRefreshResult | null> {
  // SC accepts either a handle (without the leading @) or a full URL.
  const json = await scFetchJson<Record<string, unknown>>("/v1/youtube/channel", { handle });
  if (!json) return null;
  return {
    displayName: (json.name as string | undefined) ?? (json.title as string | undefined) ?? null,
    avatarUrl: (json.avatar as string | undefined) ?? (json.thumbnail as string | undefined) ?? null,
    bio: (json.description as string | undefined) ?? null,
    followerCount: pickInt(json, ["subscriberCountInt", "subscriberCount", "subscribers"]),
    externalId: (json.id as string | undefined) ?? (json.channelId as string | undefined) ?? null,
    url: (json.url as string | undefined) ?? null,
    metadata: json,
  };
}

async function fetchInstagramProfile(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/instagram/profile", { handle });
  if (!json) return null;
  // SC IG profile nests data under `data.user` on some endpoints; tolerate both.
  const user = ((json as { data?: { user?: Record<string, unknown> } }).data?.user ?? json) as Record<string, unknown>;
  return {
    displayName: (user.full_name as string | undefined) ?? (user.username as string | undefined) ?? null,
    avatarUrl: (user.profile_pic_url_hd as string | undefined) ?? (user.profile_pic_url as string | undefined) ?? null,
    bio: (user.biography as string | undefined) ?? null,
    followerCount: pickInt(user, ["follower_count", "edge_followed_by.count", "followers"]),
    externalId: (user.id as string | undefined) ?? (user.pk as string | undefined) ?? null,
    url: `https://www.instagram.com/${handle}`,
    metadata: user,
  };
}

async function fetchXUser(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/twitter/user", { handle });
  if (!json) return null;
  const legacy = (json as { legacy?: Record<string, unknown> }).legacy ?? json;
  return {
    displayName: (legacy.name as string | undefined) ?? null,
    avatarUrl: (legacy.profile_image_url_https as string | undefined) ?? null,
    bio: (legacy.description as string | undefined) ?? null,
    followerCount: pickInt(legacy, ["followers_count"]),
    externalId: (json.rest_id as string | undefined) ?? null,
    url: `https://x.com/${handle}`,
    metadata: json,
  };
}

async function fetchTikTokUser(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v2/tiktok/user", { handle });
  if (!json) return null;
  const user = (json as { user?: Record<string, unknown> }).user ?? json;
  return {
    displayName: (user.nickname as string | undefined) ?? null,
    avatarUrl: (user.avatar_larger as string | undefined) ?? (user.avatar_thumb as string | undefined) ?? null,
    bio: (user.signature as string | undefined) ?? null,
    followerCount: pickInt(user, ["follower_count", "fans"]),
    externalId: (user.id as string | undefined) ?? (user.sec_uid as string | undefined) ?? null,
    url: `https://www.tiktok.com/@${handle}`,
    metadata: json,
  };
}

async function fetchLinkedinProfile(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/linkedin/profile", { handle });
  if (!json) return null;
  return {
    displayName: (json.fullName as string | undefined) ?? (json.name as string | undefined) ?? null,
    avatarUrl: (json.profilePicture as string | undefined) ?? (json.avatar as string | undefined) ?? null,
    bio: (json.about as string | undefined) ?? (json.summary as string | undefined) ?? null,
    followerCount: pickInt(json, ["followersCount", "followers"]),
    externalId: (json.id as string | undefined) ?? null,
    url: (json.url as string | undefined) ?? `https://www.linkedin.com/in/${handle}`,
    metadata: json,
  };
}

async function fetchThreadsUser(handle: string): Promise<AccountRefreshResult | null> {
  const json = await scFetchJson<Record<string, unknown>>("/v1/threads/user", { handle });
  if (!json) return null;
  return {
    displayName: (json.full_name as string | undefined) ?? (json.username as string | undefined) ?? null,
    avatarUrl: (json.profile_pic_url as string | undefined) ?? null,
    bio: (json.biography as string | undefined) ?? null,
    followerCount: pickInt(json, ["follower_count", "followers"]),
    externalId: (json.id as string | undefined) ?? (json.pk as string | undefined) ?? null,
    url: `https://www.threads.net/@${handle}`,
    metadata: json,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Refresh the given account: fetch SC data for its platform+handle, write
 * back to `accounts`, stamp success / error. Returns the refreshed row.
 *
 * Platforms with no SC coverage (newsletter, "other") stamp
 * `lastRefreshedAt` + a descriptive error message and return — the sweep
 * won't retry them every run.
 */
export async function refreshAccount(accountId: string): Promise<void> {
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
        result = await fetchLinkedinProfile(handle);
        break;
      case "threads":
        result = await fetchThreadsUser(handle);
        break;
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
    return;
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
    return;
  }

  // Partial-update: only overwrite columns SC gave us a value for. Don't
  // wipe a previously-set follower count with null just because this run
  // missed it.
  const patch: Partial<typeof accounts.$inferInsert> = {
    lastRefreshedAt: new Date(),
    lastRefreshError: null,
    updatedAt: new Date(),
  };
  if (result.displayName != null) patch.displayName = result.displayName;
  if (result.avatarUrl != null) patch.avatarUrl = result.avatarUrl;
  if (result.bio != null) patch.bio = result.bio;
  if (result.followerCount != null) patch.followerCount = result.followerCount;
  if (result.externalId != null) patch.externalId = result.externalId;
  if (result.url != null) patch.url = result.url;
  if (result.metadata) patch.metadata = result.metadata;

  await db.update(accounts).set(patch).where(eq(accounts.id, accountId));
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function pickInt(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    // Support "edge_followed_by.count" dotted-path lookups for IG.
    const parts = key.split(".");
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        cur = undefined;
        break;
      }
    }
    if (typeof cur === "number" && Number.isFinite(cur)) return Math.floor(cur);
    if (typeof cur === "string" && /^\d+$/.test(cur)) return parseInt(cur, 10);
  }
  return null;
}
