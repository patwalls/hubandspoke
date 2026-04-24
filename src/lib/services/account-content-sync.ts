/**
 * Per-account content sync via ScrapeCreators.
 *
 * Replaces the hardcoded MATG-only `matg-sync.ts`. Parameterized on an
 * `accounts` row — the same code path pulls content for any brand/handle.
 *
 * Two modes:
 *   - `latest`   — one page of the user's timeline. Daily sweep + manual
 *                  "Sync" button. Cheap (1–2 SC credits per call).
 *   - `backfill` — paginate back to up to `maxPages` pages. Runs once when
 *                  an account is first added. Cost-capped by `maxPages`.
 *
 * Platform support (documented in docs/automation.md):
 *   youtube    — long + shorts, full catalog via continuationToken
 *   instagram  — full history via next_max_id
 *   tiktok     — full history via max_cursor
 *   linkedin   — company pages only, max 7 pages (platform cap)
 *   x          — latest-only (SC returns top 100 by engagement; no cursor)
 *   threads    — latest-only (platform exposes only ~20–30 recent posts)
 *   newsletter/other — skipped (no SC coverage)
 *
 * Dedup: items are keyed by `(account_id, platform_content_id)` via a
 * partial unique index on production_items. A publishedLink fallback catches
 * legacy rows that predate the column.
 */

import { db } from "@/lib/db";
import { productionItems, syncLogs, accounts, brands } from "@/lib/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { resolveAssignees } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import type { PostType } from "@/lib/platform-field-schemas";
import { SC_BASE, headers } from "@/lib/services/sc-client";
import type { SCTweet } from "@/lib/services/sc-fetchers";

// ─── Support matrix ───────────────────────────────────────────────────────

const LATEST_SUPPORTED = new Set([
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
  "x",
  "threads",
]);

/** Platforms where we paginate on `backfill`. Others collapse to latest. */
const BACKFILL_SUPPORTED = new Set([
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
]);

export function platformSupportsLatest(platform: string): boolean {
  return LATEST_SUPPORTED.has(platform);
}

export function platformSupportsBackfill(platform: string): boolean {
  return BACKFILL_SUPPORTED.has(platform);
}

/**
 * Best-effort default format per post type. Drives assignee resolution (via
 * `formats.producer_notion_user_id`) and UI grouping. Null means "let the
 * user pick" — the row is still valid and assignees fall back to the brand
 * defaults. `youtube_long` intentionally stays null since format names vary
 * per brand (MATG uses "Business Interview"; others differ).
 */
const DEFAULT_FORMAT_BY_POST_TYPE: Partial<Record<PostType, string>> = {
  youtube_shorts: "YouTube Short",
  instagram_reel: "Instagram Reel",
  instagram_post: "Instagram Post",
  x: "Tweet",
  tiktok: "TikTok",
  linkedin: "LinkedIn Post",
  threads: "Threads",
};

const PLATFORM_LABEL: Record<PostType, string> = {
  youtube_long: "YouTube",
  youtube_shorts: "YouTube Shorts",
  youtube_community: "YouTube Community",
  instagram_reel: "Instagram Reel",
  instagram_post: "Instagram Post",
  instagram_story: "Instagram Story",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  threads: "Threads",
  newsletter: "Newsletter",
};

// ─── Types ────────────────────────────────────────────────────────────────

export interface SyncResult {
  accountId: string;
  platform: string;
  handle: string;
  mode: "latest" | "backfill";
  pagesFetched: number;
  creditsUsed: number;
  fetched: number;
  created: number;
  updated: number;
  errors: number;
  errorMessage?: string;
}

interface NormalizedItem {
  platformContentId: string;
  publishedLink: string;
  postType: PostType;
  title: string;
  thumbnail: string | null;
  publishedAt: Date | null;
  publishedDate: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  contentBody?: string | null;
  contentBodySource?: string | null;
  youtubeId?: string | null;
}

// SC response shapes (not exported — internal to this module).
interface SCVideo {
  type: string;
  id: string;
  url: string;
  title: string;
  description?: string;
  thumbnail: string;
  viewCountInt: number;
  publishedTimeText: string;
  publishedTime?: string;
  lengthSeconds: number;
}

interface SCShort {
  type: string;
  id: string;
  url: string;
  title: string;
  viewCountInt: number;
  commentCountInt?: number;
  likeCountInt?: number;
  publishDate?: string;
}

interface SCInstagramPost {
  id: string;
  code: string;
  taken_at: number;
  media_type: number;
  product_type?: string;
  like_count: number;
  comment_count: number;
  play_count?: number;
  caption?: { text?: string } | null;
  url?: string;
  image_versions2?: {
    candidates?: Array<{ url: string; width: number; height: number }>;
  };
}

interface SCTikTokVideo {
  aweme_id: string;
  desc?: string;
  create_time: number;
  video?: {
    cover?: { url_list?: string[] };
    origin_cover?: { url_list?: string[] };
  };
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
  };
  share_url?: string;
  author?: { unique_id?: string };
}

interface SCLinkedInPost {
  urn?: string;
  activity_urn?: string;
  url?: string;
  text?: string;
  posted_at?: { date?: string; timestamp?: number };
  author?: { name?: string };
  stats?: {
    total_reactions?: number;
    comments?: number;
    reposts?: number;
  };
  images?: Array<{ url: string }>;
  video?: { thumbnail?: string };
}

interface SCThreadsPost {
  pk: string;
  code?: string;
  caption?: { text?: string } | null;
  taken_at?: number;
  like_count?: number;
  text_post_app_info?: {
    direct_reply_count?: number;
    view_counts?: number;
  };
  view_counts?: number;
  user?: { username?: string };
}

// ─── Date helpers ─────────────────────────────────────────────────────────

function parseRelativeTime(text: string): string | null {
  if (!text) return null;
  const now = new Date();
  const match = text.match(
    /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i
  );
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  // Only resolve units with day-level or finer precision. "N months/years
  // ago" is intentionally dropped — every such item would otherwise collapse
  // onto `today − N months` and batch an entire year of videos onto a
  // single calendar day in the weekly dashboard. Leave publishedDate null;
  // `enrichYouTubeItem` pulls the precise ISO from /v1/youtube/video on
  // the next enrichment sweep and populates it authoritatively.
  switch (unit) {
    case "second": now.setSeconds(now.getSeconds() - num); break;
    case "minute": now.setMinutes(now.getMinutes() - num); break;
    case "hour":   now.setHours(now.getHours() - num); break;
    case "day":    now.setDate(now.getDate() - num); break;
    case "week":   now.setDate(now.getDate() - num * 7); break;
    default:       return null;
  }
  return now.toISOString().split("T")[0];
}

function parseTwitterDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

function unixToDate(ts: number): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString().split("T")[0];
}

// ─── Paginated fetchers (per platform) ────────────────────────────────────
// Each returns a list of normalized items plus the number of SC calls made.

async function scGetJson(path: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  const url = `${SC_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SC ${path} ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

/** `scGetJson` variant that returns null on a 404 instead of throwing. Use
 *  only for endpoints where "not found" is a legitimate empty state — e.g.
 *  the YouTube Shorts feed on a channel that only posts long-form. Any
 *  other non-OK status still surfaces as an error. */
async function scGetJsonNullOn404(
  path: string,
  query: Record<string, string>
): Promise<Record<string, unknown> | null> {
  const qs = new URLSearchParams(query).toString();
  const url = `${SC_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SC ${path} ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function fetchYouTubeLong(
  handle: string,
  maxPages: number
): Promise<{ items: NormalizedItem[]; credits: number }> {
  const items: NormalizedItem[] = [];
  let credits = 0;
  let continuationToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query: Record<string, string> = {
      handle: handle.startsWith("@") ? handle : `@${handle}`,
      sort: "latest",
    };
    if (continuationToken) query.continuationToken = continuationToken;
    const data = await scGetJson("/v1/youtube/channel-videos", query);
    credits++;
    const videos: SCVideo[] = data.videos || [];
    for (const v of videos) {
      if (!v.id || !v.url) continue;
      items.push({
        platformContentId: v.id,
        youtubeId: v.id,
        publishedLink: v.url,
        postType: "youtube_long",
        title: v.title ?? "(untitled)",
        thumbnail: v.thumbnail ?? null,
        publishedAt: v.publishedTime ? new Date(v.publishedTime) : null,
        publishedDate: v.publishedTime
          ? v.publishedTime.split("T")[0]
          : parseRelativeTime(v.publishedTimeText ?? ""),
        views: v.viewCountInt ?? null,
        likes: null,
        comments: null,
      });
    }
    continuationToken = data.continuationToken;
    if (!continuationToken || videos.length === 0) break;
  }
  return { items, credits };
}

/**
 * Latest shorts endpoint (single call) — cheap. The "simple" variant that
 * auto-paginates is left for future backfill use; for now we grab one page
 * worth and rely on the regular-cadence sweep to keep up.
 */
async function fetchYouTubeShortsLatest(
  handle: string
): Promise<{ items: NormalizedItem[]; credits: number }> {
  // SC returns 404 for channels with no Shorts feed (e.g. long-form-only
  // podcasts). Treat that as an empty page, not a sync failure.
  const data = await scGetJsonNullOn404("/v1/youtube/channel/shorts", {
    handle: handle.startsWith("@") ? handle : `@${handle}`,
  });
  if (!data) return { items: [], credits: 0 };
  const shorts: SCShort[] = (data.shorts as SCShort[]) || [];
  const items: NormalizedItem[] = shorts
    .filter((s) => s.id && s.url)
    .map((s) => ({
      platformContentId: s.id,
      youtubeId: s.id,
      publishedLink: s.url,
      postType: "youtube_shorts" as const,
      title: s.title ?? "(untitled)",
      thumbnail: null,
      publishedAt: s.publishDate ? new Date(s.publishDate) : null,
      publishedDate: s.publishDate ? s.publishDate.split("T")[0] : null,
      views: s.viewCountInt ?? null,
      likes: s.likeCountInt ?? null,
      comments: s.commentCountInt ?? null,
    }));
  return { items, credits: 1 };
}

async function fetchYouTubeShortsBackfill(
  handle: string
): Promise<{ items: NormalizedItem[]; credits: number }> {
  // The /simple endpoint handles pagination internally and returns the full
  // catalog. SC charges more credits for it (one per underlying page), which
  // is still a better deal than doing the paging ourselves against /shorts.
  // 404 means the channel has no Shorts feed — keep the long-form items
  // already fetched and return empty rather than failing the whole backfill.
  const data = await scGetJsonNullOn404("/v1/youtube/channel/shorts/simple", {
    handle: handle.startsWith("@") ? handle : `@${handle}`,
  });
  if (!data) return { items: [], credits: 0 };
  const shorts: SCShort[] = (data.shorts as SCShort[]) || (data.videos as SCShort[]) || [];
  const items: NormalizedItem[] = shorts
    .filter((s) => s.id && s.url)
    .map((s) => ({
      platformContentId: s.id,
      youtubeId: s.id,
      publishedLink: s.url,
      postType: "youtube_shorts" as const,
      title: s.title ?? "(untitled)",
      thumbnail: null,
      publishedAt: s.publishDate ? new Date(s.publishDate) : null,
      publishedDate: s.publishDate ? s.publishDate.split("T")[0] : null,
      views: s.viewCountInt ?? null,
      likes: s.likeCountInt ?? null,
      comments: s.commentCountInt ?? null,
    }));
  // Best-effort credit accounting — SC doesn't return a page count.
  const estimatedCredits = Math.max(1, Math.ceil(items.length / 30));
  return { items, credits: estimatedCredits };
}

async function fetchInstagramPostsPaged(
  handle: string,
  maxPages: number
): Promise<{ items: NormalizedItem[]; credits: number }> {
  const items: NormalizedItem[] = [];
  let credits = 0;
  let nextMaxId: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query: Record<string, string> = { handle };
    if (nextMaxId) query.next_max_id = nextMaxId;
    const data = await scGetJson("/v2/instagram/user/posts", query);
    credits++;
    const posts: SCInstagramPost[] = data.items || [];
    for (const p of posts) {
      const code = p.code;
      if (!code) continue;
      const url = p.url || `https://www.instagram.com/p/${code}/`;
      const isReel = p.product_type === "clips" || p.media_type === 2;
      const caption =
        typeof p.caption === "object" && p.caption?.text
          ? p.caption.text
          : null;
      const thumbnail = p.image_versions2?.candidates?.[0]?.url ?? null;
      items.push({
        platformContentId: code,
        publishedLink: url,
        postType: isReel ? "instagram_reel" : "instagram_post",
        title: caption
          ? caption.slice(0, 120) + (caption.length > 120 ? "..." : "")
          : "(No caption)",
        thumbnail,
        publishedAt: p.taken_at ? new Date(p.taken_at * 1000) : null,
        publishedDate: unixToDate(p.taken_at),
        views: p.play_count ?? null,
        likes: p.like_count ?? null,
        comments: p.comment_count ?? null,
        contentBody: caption,
        contentBodySource: caption ? "scrape_creators" : null,
      });
    }
    nextMaxId = data.next_max_id;
    if (!nextMaxId || data.more_available === false || posts.length === 0) break;
  }
  return { items, credits };
}

async function fetchTikTokVideosPaged(
  handle: string,
  maxPages: number
): Promise<{ items: NormalizedItem[]; credits: number }> {
  const items: NormalizedItem[] = [];
  let credits = 0;
  let maxCursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query: Record<string, string> = { handle, sort_by: "latest" };
    if (maxCursor) query.max_cursor = maxCursor;
    const data = await scGetJson("/v3/tiktok/profile/videos", query);
    credits++;
    const videos: SCTikTokVideo[] = data.aweme_list || [];
    for (const v of videos) {
      if (!v.aweme_id) continue;
      const url =
        v.share_url ||
        `https://www.tiktok.com/@${v.author?.unique_id ?? handle}/video/${v.aweme_id}`;
      const desc = v.desc ?? "";
      const thumbnail =
        v.video?.cover?.url_list?.[0] ??
        v.video?.origin_cover?.url_list?.[0] ??
        null;
      items.push({
        platformContentId: v.aweme_id,
        publishedLink: url,
        postType: "tiktok",
        title: desc
          ? desc.slice(0, 120) + (desc.length > 120 ? "..." : "")
          : "(No caption)",
        thumbnail,
        publishedAt: v.create_time ? new Date(v.create_time * 1000) : null,
        publishedDate: unixToDate(v.create_time),
        views: v.statistics?.play_count ?? null,
        likes: v.statistics?.digg_count ?? null,
        comments: v.statistics?.comment_count ?? null,
        contentBody: desc || null,
        contentBodySource: desc ? "scrape_creators" : null,
      });
    }
    maxCursor = data.max_cursor ? String(data.max_cursor) : undefined;
    if (!maxCursor || data.has_more === false || videos.length === 0) break;
  }
  return { items, credits };
}

async function fetchLinkedInCompanyPostsPaged(
  companyUrl: string,
  maxPages: number
): Promise<{ items: NormalizedItem[]; credits: number }> {
  // LinkedIn caps pagination at 7 pages.
  const hardCap = Math.min(maxPages, 7);
  const items: NormalizedItem[] = [];
  let credits = 0;
  for (let page = 1; page <= hardCap; page++) {
    const data = await scGetJson("/v1/linkedin/company/posts", {
      url: companyUrl,
      page: String(page),
    });
    credits++;
    const posts: SCLinkedInPost[] = data.posts || data.items || [];
    for (const p of posts) {
      const contentId = p.activity_urn || p.urn;
      const url = p.url;
      if (!contentId || !url) continue;
      const body = p.text ?? "";
      const thumbnail =
        p.video?.thumbnail ?? p.images?.[0]?.url ?? null;
      const postedTs = p.posted_at?.timestamp;
      items.push({
        platformContentId: String(contentId),
        publishedLink: url,
        postType: "linkedin",
        title: body
          ? body.slice(0, 120) + (body.length > 120 ? "..." : "")
          : "(No caption)",
        thumbnail,
        publishedAt: postedTs ? new Date(postedTs) : null,
        publishedDate: postedTs ? new Date(postedTs).toISOString().split("T")[0] : null,
        views: null,
        likes: p.stats?.total_reactions ?? null,
        comments: p.stats?.comments ?? null,
        contentBody: body || null,
        contentBodySource: body ? "scrape_creators" : null,
      });
    }
    if (posts.length === 0) break;
  }
  return { items, credits };
}

async function fetchXTweetsLatest(
  handle: string
): Promise<{ items: NormalizedItem[]; credits: number }> {
  const data = await scGetJson("/v1/twitter/user-tweets", { handle });
  const tweets: SCTweet[] = data.tweets || [];
  const items: NormalizedItem[] = tweets
    .filter((t) => t.rest_id && t.url && t.legacy)
    .map((t) => {
      const fullText = t.legacy.full_text || "";
      const thumbnail = t.legacy.entities?.media?.[0]?.media_url_https ?? null;
      const viewCount = t.views?.count ? parseInt(t.views.count, 10) : null;
      return {
        platformContentId: t.rest_id,
        publishedLink: t.url,
        postType: "x" as const,
        title:
          fullText.length > 120 ? fullText.slice(0, 120) + "..." : fullText,
        thumbnail,
        publishedAt: t.legacy.created_at
          ? new Date(t.legacy.created_at)
          : null,
        publishedDate: parseTwitterDate(t.legacy.created_at),
        views: viewCount,
        likes: t.legacy.favorite_count ?? null,
        comments: t.legacy.reply_count ?? null,
        contentBody: fullText || null,
        contentBodySource: fullText ? "scrape_creators" : null,
      };
    });
  return { items, credits: 1 };
}

async function fetchThreadsLatest(
  handle: string
): Promise<{ items: NormalizedItem[]; credits: number }> {
  const data = await scGetJson("/v1/threads/user/posts", { handle });
  const posts: SCThreadsPost[] = data.posts || data.items || [];
  const items: NormalizedItem[] = posts
    .filter((p) => p.pk)
    .map((p) => {
      const body = p.caption?.text ?? "";
      const code = p.code;
      const username = p.user?.username ?? handle;
      const url = code
        ? `https://www.threads.net/@${username}/post/${code}`
        : `https://www.threads.net/@${username}`;
      return {
        platformContentId: p.pk,
        publishedLink: url,
        postType: "threads" as const,
        title: body
          ? body.slice(0, 120) + (body.length > 120 ? "..." : "")
          : "(No caption)",
        thumbnail: null,
        publishedAt: p.taken_at ? new Date(p.taken_at * 1000) : null,
        publishedDate: unixToDate(p.taken_at ?? 0),
        views: p.view_counts ?? p.text_post_app_info?.view_counts ?? null,
        likes: p.like_count ?? null,
        comments: p.text_post_app_info?.direct_reply_count ?? null,
        contentBody: body || null,
        contentBodySource: body ? "scrape_creators" : null,
      };
    });
  return { items, credits: 1 };
}

// ─── Upsert ───────────────────────────────────────────────────────────────

/** Look up any productionItems that match a list of platformContentIds OR
 *  publishedLinks for this account. Returned maps are used to decide
 *  update-vs-insert per item. */
async function loadExisting(
  accountId: string,
  items: NormalizedItem[]
): Promise<{
  byContentId: Map<string, string>;
  byLink: Map<string, string>;
}> {
  if (items.length === 0) {
    return { byContentId: new Map(), byLink: new Map() };
  }
  const contentIds = items.map((i) => i.platformContentId).filter(Boolean);
  const links = items.map((i) => i.publishedLink).filter(Boolean);
  const rows = await db
    .select({
      id: productionItems.id,
      platformContentId: productionItems.platformContentId,
      publishedLink: productionItems.publishedLink,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.accountId, accountId),
        or(
          contentIds.length
            ? inArray(productionItems.platformContentId, contentIds)
            : undefined,
          links.length
            ? inArray(productionItems.publishedLink, links)
            : undefined
        )
      )
    );
  const byContentId = new Map<string, string>();
  const byLink = new Map<string, string>();
  for (const r of rows) {
    if (r.platformContentId) byContentId.set(r.platformContentId, r.id);
    if (r.publishedLink) byLink.set(r.publishedLink, r.id);
  }
  return { byContentId, byLink };
}

async function upsertItems(
  accountId: string,
  brandSlug: string,
  items: NormalizedItem[]
): Promise<{ created: number; updated: number; errors: number }> {
  let created = 0;
  let updated = 0;
  let errors = 0;
  if (items.length === 0) return { created, updated, errors };

  const { byContentId, byLink } = await loadExisting(accountId, items);

  for (const item of items) {
    try {
      const existingId =
        byContentId.get(item.platformContentId) ??
        byLink.get(item.publishedLink) ??
        null;

      const baseUpdate = {
        title: item.title,
        thumbnail: item.thumbnail ?? undefined,
        publishedDate: item.publishedDate,
        publishedAt: item.publishedAt,
        status: "Published" as const,
        platform: [PLATFORM_LABEL[item.postType] ?? item.postType] as string[],
        accountId,
        postType: item.postType,
        brand: brandSlug,
        publishedLink: item.publishedLink,
        platformContentId: item.platformContentId,
        views: item.views ?? undefined,
        likes: item.likes ?? undefined,
        comments: item.comments ?? undefined,
        contentBody: item.contentBody ?? undefined,
        contentBodyFetchedAt: item.contentBody ? new Date() : undefined,
        contentBodySource: item.contentBodySource ?? undefined,
        isExternal: false,
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
        ...(item.youtubeId
          ? { youtubeUrl: item.publishedLink, youtubeId: item.youtubeId }
          : {}),
      };

      if (existingId) {
        await db
          .update(productionItems)
          .set(baseUpdate)
          .where(eq(productionItems.id, existingId));
        updated++;
      } else {
        const format = DEFAULT_FORMAT_BY_POST_TYPE[item.postType] ?? null;
        const assignees = await resolveAssignees({
          brand: brandSlug,
          format,
        });
        await db.insert(productionItems).values({
          ...baseUpdate,
          format,
          utmCampaign: await generateUtmCampaign(item.title),
          producerUserId: assignees.producerUserId,
          editorUserId: assignees.editorUserId,
        });
        created++;
      }
    } catch (err) {
      console.error(
        `[account-content-sync] upsert failed for ${item.publishedLink}:`,
        err
      );
      errors++;
    }
  }

  return { created, updated, errors };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

export interface SyncAccountContentOpts {
  mode: "latest" | "backfill";
  maxPages?: number;
  since?: Date;
}

export async function syncAccountContent(
  accountId: string,
  opts: SyncAccountContentOpts
): Promise<SyncResult> {
  const [row] = await db
    .select({
      id: accounts.id,
      platform: accounts.platform,
      handle: accounts.handle,
      url: accounts.url,
      brandSlug: brands.slug,
    })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!row) throw new Error(`account-content-sync: account not found: ${accountId}`);

  const result: SyncResult = {
    accountId,
    platform: row.platform,
    handle: row.handle,
    mode: opts.mode,
    pagesFetched: 0,
    creditsUsed: 0,
    fetched: 0,
    created: 0,
    updated: 0,
    errors: 0,
  };
  const startedAt = new Date();

  if (!LATEST_SUPPORTED.has(row.platform)) {
    const msg = `platform ${row.platform} has no SC content-list support`;
    await db
      .update(accounts)
      .set({
        lastContentSyncAt: new Date(),
        lastContentSyncError: msg,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
    result.errorMessage = msg;
    return result;
  }

  const effectiveMode: "latest" | "backfill" =
    opts.mode === "backfill" && !BACKFILL_SUPPORTED.has(row.platform)
      ? "latest"
      : opts.mode;
  const maxPages =
    opts.maxPages ?? (effectiveMode === "backfill" ? 50 : 1);

  try {
    // Fan out per platform. YouTube yields two passes (long + shorts) under
    // the same accountId because one channel hosts both post types.
    const fetched: NormalizedItem[] = [];
    let credits = 0;
    let pages = 0;

    switch (row.platform) {
      case "youtube": {
        const long = await fetchYouTubeLong(row.handle, maxPages);
        fetched.push(...long.items);
        credits += long.credits;
        pages += long.credits; // 1 page per credit for the long endpoint
        const shorts =
          effectiveMode === "backfill"
            ? await fetchYouTubeShortsBackfill(row.handle)
            : await fetchYouTubeShortsLatest(row.handle);
        fetched.push(...shorts.items);
        credits += shorts.credits;
        pages += 1;
        break;
      }
      case "instagram": {
        const r = await fetchInstagramPostsPaged(row.handle, maxPages);
        fetched.push(...r.items);
        credits += r.credits;
        pages += r.credits;
        break;
      }
      case "tiktok": {
        const r = await fetchTikTokVideosPaged(row.handle, maxPages);
        fetched.push(...r.items);
        credits += r.credits;
        pages += r.credits;
        break;
      }
      case "linkedin": {
        if (!row.url || !row.url.includes("/company/")) {
          throw new Error(
            "LinkedIn content sync requires a company page URL (linkedin.com/company/...) — personal profiles aren't supported"
          );
        }
        const r = await fetchLinkedInCompanyPostsPaged(row.url, maxPages);
        fetched.push(...r.items);
        credits += r.credits;
        pages += r.credits;
        break;
      }
      case "x": {
        const r = await fetchXTweetsLatest(row.handle);
        fetched.push(...r.items);
        credits += r.credits;
        pages += 1;
        break;
      }
      case "threads": {
        const r = await fetchThreadsLatest(row.handle);
        fetched.push(...r.items);
        credits += r.credits;
        pages += 1;
        break;
      }
    }

    // `since` filter: clip historical pages once we've walked past the cutoff.
    const filtered = opts.since
      ? fetched.filter(
          (i) => !i.publishedAt || i.publishedAt.getTime() >= opts.since!.getTime()
        )
      : fetched;

    result.fetched = filtered.length;
    result.creditsUsed = credits;
    result.pagesFetched = pages;

    const upsert = await upsertItems(accountId, row.brandSlug, filtered);
    result.created = upsert.created;
    result.updated = upsert.updated;
    result.errors = upsert.errors;

    await db
      .update(accounts)
      .set({
        lastContentSyncAt: new Date(),
        lastContentSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(accounts)
      .set({
        lastContentSyncAt: new Date(),
        lastContentSyncError: msg,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
    result.errorMessage = msg;
    result.errors++;
  }

  await db.insert(syncLogs).values({
    syncType: `account-content-sync:${row.platform}`,
    status: result.errorMessage ? "error" : "success",
    itemsFetched: result.fetched,
    itemsCreated: result.created,
    itemsUpdated: result.updated,
    errorMessage: result.errorMessage ?? null,
    startedAt,
    completedAt: new Date(),
  });

  return result;
}
