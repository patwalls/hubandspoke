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
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { resolveEditor } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { findCrossAccountDuplicate } from "@/lib/services/production-items-dedup";
import { recordItemCreated } from "@/lib/services/item-created";
import { scheduleVelocitySnapshots } from "@/jobs/tasks/capture-velocity-snapshot";
import type { PostType } from "@/lib/platform-field-schemas";
import { SC_BASE, headers } from "@/lib/services/sc-client";
import type { SCTweet } from "@/lib/services/sc-fetchers";
import { extractContentId, looseUrlKey } from "@/lib/platform-url";
import { estimateViewsFromLikes } from "@/lib/services/view-estimator";

// ─── Support matrix ───────────────────────────────────────────────────────

const LATEST_SUPPORTED = new Set([
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
  "x",
  "threads",
  "facebook",
]);

/** Platforms where we paginate on `backfill`. Others collapse to latest. */
const BACKFILL_SUPPORTED = new Set([
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
  "facebook",
]);

export function platformSupportsLatest(platform: string): boolean {
  return LATEST_SUPPORTED.has(platform);
}

export function platformSupportsBackfill(platform: string): boolean {
  return BACKFILL_SUPPORTED.has(platform);
}

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
  snapchat_story: "Snapchat Story",
  snapchat_spotlight: "Snapchat Spotlight",
  facebook_post: "Facebook",
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
  // Posts that already exist on a *different* account (same X tweet retweeted
  // onto our other handle, etc.). Skipped to avoid double-counting metrics.
  // Surfaced via lastContentSyncError so operators notice.
  skippedDuplicates: number;
  errorMessage?: string;
  /** "permanent" when the account is deactivated, private, or wrong-typed —
   *  retrying daily can never recover. Caller should disable the account
   *  rather than re-throw to Sentry. "transient" for everything else (rate
   *  limits, upstream blips, our bugs). */
  errorKind?: "permanent" | "transient";
}

/**
 * Detect Scrape Creators / config failures that can never recover by
 * retrying — the user account is gone, private, or misconfigured. The
 * daily cron will hit the same 404 forever otherwise, paging Sentry each
 * time.
 *
 * Match on the exact substrings SC emits + our own validation messages.
 * Conservative on purpose: anything not on this list is treated as
 * transient and surfaces normally.
 */
function isPermanentSyncFailure(message: string): boolean {
  return (
    // TikTok: SC returns 404 + `account_deactivated:true`
    /account_deactivated/i.test(message) ||
    /"message":"Account deactivated"/i.test(message) ||
    // Threads: SC returns 404 + "Shoot looks like the user is not found, or
    // is private and needs to be accessed by a logged in account"
    /Shoot looks like the user is not found/i.test(message) ||
    // LinkedIn: our own validation when an operator sets a personal-profile URL
    /LinkedIn content sync requires a company page URL/i.test(message)
  );
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
  // The live `/v1/linkedin/company/posts` response is lean: each post is just
  // `{ url, id, datePublished, text }`. The `urn`/`posted_at`/`stats`/`images`
  // fields below are kept optional so we stay forward-compatible if SC ever
  // enriches the payload — but the mapping must not REQUIRE them, or every
  // post gets skipped (which is exactly the bug this shape revealed).
  id?: string;
  urn?: string;
  activity_urn?: string;
  url?: string;
  text?: string;
  datePublished?: string;
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
    // Reply markers — Meta's internal API exposes one or more of these on
    // posts that are replies in a chain rather than top-level posts. Field
    // names vary across SC response shapes; we treat any truthy signal as
    // "this is a reply" and exclude it from sync.
    is_reply?: boolean;
    reply_to_author?: { username?: string; pk?: string } | null;
    reply_to_id?: string | null;
  };
  view_counts?: number;
  user?: { username?: string };
  // Top-level reply markers seen in some SC response shapes.
  is_reply?: boolean;
  parent_pk?: string | null;
  parent_post_pk?: string | null;
  in_reply_to_id?: string | null;
}

interface SCFacebookPost {
  id: string;
  text?: string;
  url?: string;
  permalink?: string;
  reactionCount?: number;
  commentCount?: number;
  videoViewCount?: number | null;
  publishTime?: number;
  videoDetails?: { thumbnail?: string; sdUrl?: string; hdUrl?: string } | null;
}

/**
 * Whether a Threads post is a reply rather than a top-level post. Defensive
 * across the field-name variants we've seen — flips true if any reply
 * marker is set. False positives are preferred over false negatives:
 * dropping a top-level post is worse than missing one CTA reply, since the
 * user is asking us to exclude replies entirely.
 */
function isThreadsReply(post: SCThreadsPost): boolean {
  if (post.is_reply === true) return true;
  if (post.parent_pk || post.parent_post_pk || post.in_reply_to_id) return true;
  const tpai = post.text_post_app_info;
  if (!tpai) return false;
  if (tpai.is_reply === true) return true;
  if (tpai.reply_to_author) return true;
  if (tpai.reply_to_id) return true;
  return false;
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

/**
 * Map one Scrape Creators company post onto a NormalizedItem, or null when it
 * lacks the minimum (a URL + a derivable content id).
 *
 * Exported for testing. The live `/v1/linkedin/company/posts` payload is lean
 * — `{ url, id, datePublished, text }` — but earlier code keyed the dedup id on
 * `activity_urn`/`urn` and the date on `posted_at.timestamp`, neither of which
 * the live API returns, so every post was silently skipped. This handles both
 * shapes: prefer the live fields, fall back to the legacy ones.
 */
export function normalizeLinkedInCompanyPost(
  p: SCLinkedInPost
): NormalizedItem | null {
  const url = p.url;
  if (!url) return null;
  const contentId =
    p.id || p.activity_urn || p.urn || extractContentId("linkedin", url);
  if (!contentId) return null;
  const body = p.text ?? "";
  const thumbnail = p.video?.thumbnail ?? p.images?.[0]?.url ?? null;
  const rawDate = p.datePublished
    ? new Date(p.datePublished)
    : p.posted_at?.timestamp
      ? new Date(p.posted_at.timestamp)
      : null;
  const publishedAt =
    rawDate && !Number.isNaN(rawDate.getTime()) ? rawDate : null;
  return {
    platformContentId: String(contentId),
    publishedLink: url,
    postType: "linkedin",
    title: body
      ? body.slice(0, 120) + (body.length > 120 ? "..." : "")
      : "(No caption)",
    thumbnail,
    publishedAt,
    publishedDate: publishedAt ? publishedAt.toISOString().split("T")[0] : null,
    // Engagement/views aren't in the company-posts payload — leave null rather
    // than fabricate zeros.
    // The company-FEED payload carries no engagement — likes/comments/views
    // are filled in afterward by the hourly `performance-decay` job, which
    // calls `/v1/linkedin/post` per item (see performance-decay.ts → the
    // `kinds.has("linkedin")` branch). Views aren't returned by SC for
    // LinkedIn at all, so decay estimates them from likes (viewsEstimated).
    // Leave everything null here rather than fabricate zeros.
    views: null,
    likes: p.stats?.total_reactions ?? null,
    comments: p.stats?.comments ?? null,
    contentBody: body || null,
    contentBodySource: body ? "scrape_creators" : null,
  };
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
      const item = normalizeLinkedInCompanyPost(p);
      if (item) items.push(item);
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

  // One-line trace per sync of which reply markers SC actually returned, so
  // we can confirm `isThreadsReply` is checking the right field names. Drop
  // this once we've seen real production traffic and confirmed coverage.
  const replyCounts = posts.reduce(
    (acc, p) => {
      if (isThreadsReply(p)) acc.replies++;
      else acc.topLevel++;
      return acc;
    },
    { replies: 0, topLevel: 0 }
  );
  console.log(
    `[threads-sync] handle=${handle} posts=${posts.length} top_level=${replyCounts.topLevel} replies_skipped=${replyCounts.replies}`
  );

  const items: NormalizedItem[] = posts
    .filter((p) => p.pk && p.code)
    .filter((p) => !isThreadsReply(p))
    .map((p) => {
      const body = p.caption?.text ?? "";
      const code = p.code as string;
      const username = p.user?.username ?? handle;
      const url = `https://www.threads.net/@${username}/post/${code}`;
      return {
        // Use the URL-stable `code` (not the numeric `pk`) so rows from
        // sync line up with rows from manual "Add from link" — both paths
        // now agree on the same dedup key. Posts without a code are
        // dropped above; they wouldn't have a usable URL anyway.
        platformContentId: code,
        publishedLink: url,
        postType: "threads" as const,
        title: body
          ? body.slice(0, 120) + (body.length > 120 ? "..." : "")
          : "(No caption)",
        thumbnail: null,
        publishedAt: p.taken_at ? new Date(p.taken_at * 1000) : null,
        publishedDate: unixToDate(p.taken_at ?? 0),
        // SC's view_counts for Threads is unreliable on fresh posts — drop
        // it and let the estimator (likes * 150) drive views at upsert
        // time. Mirrors the per-post fix in fetchThreadsPostByUrl.
        views: null,
        likes: p.like_count ?? null,
        comments: p.text_post_app_info?.direct_reply_count ?? null,
        contentBody: body || null,
        contentBodySource: body ? "scrape_creators" : null,
      };
    });
  return { items, credits: 1 };
}

async function fetchFacebookPostsPaged(
  pageUrl: string,
  maxPages: number
): Promise<{ items: NormalizedItem[]; credits: number }> {
  const items: NormalizedItem[] = [];
  let credits = 0;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query: Record<string, string> = { url: pageUrl };
    if (cursor) query.cursor = cursor;
    const data = await scGetJson("/v1/facebook/profile/posts", query);
    credits++;
    const posts: SCFacebookPost[] = data.posts || [];
    for (const p of posts) {
      if (!p.id) continue;
      const postUrl = p.permalink ?? p.url ?? null;
      if (!postUrl) continue;
      const body = p.text ?? "";
      items.push({
        platformContentId: p.id,
        publishedLink: postUrl,
        postType: "facebook_post" as const,
        title: body
          ? body.slice(0, 120) + (body.length > 120 ? "..." : "")
          : "(No caption)",
        thumbnail: p.videoDetails?.thumbnail ?? null,
        publishedAt: p.publishTime ? new Date(p.publishTime * 1000) : null,
        publishedDate: p.publishTime ? unixToDate(p.publishTime) : null,
        views: p.videoViewCount ?? null,
        likes: p.reactionCount ?? null,
        comments: p.commentCount ?? null,
        contentBody: body || null,
        contentBodySource: body ? "scrape_creators" : null,
      });
    }
    cursor = data.cursor ?? undefined;
    if (!cursor || posts.length === 0) break;
  }
  return { items, credits };
}

// ─── Upsert ───────────────────────────────────────────────────────────────

/** Look up any productionItems for this account that might collide with an
 *  incoming sync batch. Returns one map keyed by `platform_content_id` —
 *  legacy rows that lack the column have it derived from `published_link`
 *  on the fly so manual entries created before the column existed still
 *  match. The looseUrl map is a last-ditch fallback for URLs we can't
 *  parse (custom shortlinks etc.). */
/**
 * Normalize a URL for dedup matching by removing tracking params,
 * fragments, and trailing slashes. For YouTube watch URLs the `v` param
 * IS the content ID, so we preserve it — without this, every YouTube
 * long-form video URL normalized to `youtube.com/watch` and incorrectly
 * collided in the byPublishedLink dedup map.
 */
function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    // Preserve the `v` query param for YouTube watch URLs (it's the video id)
    const isYouTubeWatch =
      /(?:^|\.)youtube\.com$/i.test(parsed.hostname) && pathname === "/watch";
    const v = isYouTubeWatch ? parsed.searchParams.get("v") : null;
    const suffix = v ? `?v=${v}` : "";
    return `${parsed.origin}${pathname}${suffix}`.toLowerCase();
  } catch {
    return null;
  }
}

async function loadExisting(
  accountId: string,
  items: NormalizedItem[]
): Promise<{
  byContentId: Map<string, string>;
  byLooseUrl: Map<string, string>;
  byPublishedLink: Map<string, string>;
}> {
  if (items.length === 0) {
    return { byContentId: new Map(), byLooseUrl: new Map(), byPublishedLink: new Map() };
  }
  const contentIds = items.map((i) => i.platformContentId).filter(Boolean);

  const rows = await db
    .select({
      id: productionItems.id,
      platformContentId: productionItems.platformContentId,
      publishedLink: productionItems.publishedLink,
      postType: productionItems.postType,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.accountId, accountId),
        or(
          contentIds.length
            ? inArray(productionItems.platformContentId, contentIds)
            : undefined,
          and(
            isNull(productionItems.platformContentId),
            isNotNull(productionItems.publishedLink)
          )
        )
      )
    );

  const byContentId = new Map<string, string>();
  const byLooseUrl = new Map<string, string>();
  const byPublishedLink = new Map<string, string>();
  for (const r of rows) {
    if (r.platformContentId) {
      byContentId.set(r.platformContentId, r.id);
      continue;
    }
    if (!r.publishedLink) continue;
    const derived = extractContentId(r.postType, r.publishedLink);
    if (derived) {
      byContentId.set(derived, r.id);
    } else {
      const key = looseUrlKey(r.publishedLink);
      if (key) byLooseUrl.set(key, r.id);
    }
    // Third fallback: normalized publishedLink for robust dedup
    const normalized = normalizeUrl(r.publishedLink);
    if (normalized) byPublishedLink.set(normalized, r.id);
  }
  return { byContentId, byLooseUrl, byPublishedLink };
}

async function upsertItems(
  accountId: string,
  brandSlug: string,
  items: NormalizedItem[]
): Promise<{
  created: number;
  updated: number;
  errors: number;
  skippedDuplicates: number;
}> {
  let created = 0;
  let updated = 0;
  let errors = 0;
  let skippedDuplicates = 0;
  if (items.length === 0)
    return { created, updated, errors, skippedDuplicates };

  const { byContentId, byLooseUrl, byPublishedLink } = await loadExisting(accountId, items);

  for (const item of items) {
    try {
      const looseKey = item.publishedLink
        ? looseUrlKey(item.publishedLink)
        : null;
      const normalizedIncomingUrl = item.publishedLink
        ? normalizeUrl(item.publishedLink)
        : null;
      const existingId =
        byContentId.get(item.platformContentId) ??
        (looseKey ? byLooseUrl.get(looseKey) : undefined) ??
        (normalizedIncomingUrl ? byPublishedLink.get(normalizedIncomingUrl) : undefined) ??
        null;

      // Resolve final (views, viewsEstimated) for post types where SC
      // doesn't return reliable view counts. When the fetcher returned
      // views=null and the post type has a likes-multiplier (threads,
      // linkedin, ig_post, yt_community per view-estimator.ts), compute
      // estimated views from likes here so the row never lands with
      // views=null when likes>0 are available. Mirrors the deriveViews
      // logic in performance-decay.ts — keep them in sync or factor out.
      let finalViews: number | null = item.views;
      let finalViewsEstimated = false;
      if (item.views == null && item.likes != null) {
        const est = estimateViewsFromLikes(item.postType, item.likes);
        if (est.estimated) {
          finalViews = est.views;
          finalViewsEstimated = true;
        }
      }

      // Per-column policy. Sync used to write the same payload to both
      // INSERT and UPDATE, which let SC clobber editorial/identity fields
      // (title flipping to a stranger's caption, publishedAt thrashing to
      // null and back). Now: INSERT writes everything; UPDATE writes only
      // engagement counters and sync timestamps. Adding a field below means
      // deciding which payload it belongs in — if in doubt, insert-only.
      const insertPayload = {
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
        views: finalViews ?? undefined,
        viewsEstimated: finalViewsEstimated,
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

      // UPDATE only writes views/viewsEstimated when we actually have a
      // new value to set — preserves whatever's in the DB (including a
      // real number from refresh-item-metrics) when this sync run had no
      // basis to compute one (e.g. SC returned null views AND null likes).
      const updatePayload = {
        views: finalViews ?? undefined,
        viewsEstimated: finalViews != null ? finalViewsEstimated : undefined,
        likes: item.likes ?? undefined,
        comments: item.comments ?? undefined,
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
      };

      if (existingId) {
        await db
          .update(productionItems)
          .set(updatePayload)
          .where(eq(productionItems.id, existingId));
        // No re-scheduling of velocity snapshots on UPDATE: under the
        // insert-only publishedAt policy, sync no longer corrects the
        // timestamp, so there's nothing for scheduleVelocitySnapshots to
        // act on. The original schedule from INSERT stands.
        updated++;
      } else {
        // Cross-account dedup: same platform_content_id already owned by a
        // *different* account. Skip + log instead of inserting — would
        // double-count metrics. The DB unique index is the safety net;
        // this branch surfaces the skip count so operators notice.
        const crossAccountDup = await findCrossAccountDuplicate({
          platformContentId: item.platformContentId,
        });
        if (crossAccountDup) {
          console.warn(
            "[account-content-sync] skipping cross-account duplicate",
            {
              incomingAccountId: accountId,
              existingItemId: crossAccountDup.id,
              existingAccountHandle: crossAccountDup.accountHandle,
              platformContentId: item.platformContentId,
              publishedLink: item.publishedLink,
            }
          );
          skippedDuplicates++;
          continue;
        }

        // No auto-format — synced posts arrive with format=null so operators
        // can tag intentionally in the UI. The hardcoded post-type → format
        // defaults that lived here historically were producing surprising
        // tags (e.g. every tweet getting `format='Tweet'`) and have been
        // removed; the LLM-driven `scripts/backfill-missing-formats.mjs`
        // is the only remaining writer that infers format and is opt-in.
        const editorUserId = await resolveEditor({
          brand: brandSlug,
          format: null,
        });
        const [inserted] = await db
          .insert(productionItems)
          .values({
            ...insertPayload,
            format: null,
            // Raw incoming syncs default to 'original'. The format is null
            // at sync time — once an editor tags a derivative format on
            // the row later, mass corrections via
            // `scripts/migrate-source-type-consolidation.mjs` reclassify
            // (or the operator does it on the format detail page via the
            // `labels_as_original` toggle). Don't defer to the resolver
            // here — null-format → 'repurposed' is wrong for raw posts.
            sourceType: "original",
            utmCampaign: await generateUtmCampaign(item.title),
            editorUserId,
            createdVia: "sync:account-content",
          })
          .returning({ id: productionItems.id });
        if (inserted) {
          try {
            await recordItemCreated(db, {
              itemId: inserted.id,
              source: "sync:account-content",
              actorUserId: null,
              format: null,
              sourceType: "original",
              postType: item.postType ?? null,
            });
          } catch (err) {
            console.error(
              "[sync:account-content] recordItemCreated failed",
              err,
            );
          }
        }
        // Schedule the 5 velocity snapshots (15m/30m/1h/2h/4h after publish)
        // so the cross-post scanner has real data when the operator hits
        // "Populate queue". Checkpoints whose windows have already closed
        // (backfill of older posts) are silently skipped.
        if (inserted && item.publishedAt) {
          await scheduleVelocitySnapshots(inserted.id, item.publishedAt);
        }
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

  return { created, updated, errors, skippedDuplicates };
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
      isActive: accounts.isActive,
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
    skippedDuplicates: 0,
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
      case "facebook": {
        if (!row.url) {
          throw new Error(
            "Facebook content sync requires a page URL — re-add the account with the full facebook.com/page-slug URL"
          );
        }
        const r = await fetchFacebookPostsPaged(row.url, maxPages);
        fetched.push(...r.items);
        credits += r.credits;
        pages += r.credits;
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
    result.skippedDuplicates = upsert.skippedDuplicates;

    await db
      .update(accounts)
      .set({
        lastContentSyncAt: new Date(),
        // Surface skipped cross-account duplicates as a soft warning so
        // operators see a non-null error chip even when the sync "succeeded".
        // A real upstream error overwrites this in the catch below.
        lastContentSyncError:
          upsert.skippedDuplicates > 0
            ? `${upsert.skippedDuplicates} cross-account duplicate${upsert.skippedDuplicates === 1 ? "" : "s"} skipped — see logs`
            : null,
        // Restore an account that was auto-deactivated by a previous
        // permanent-failure (e.g. Threads went private and came back).
        ...(row.isActive === false ? { isActive: true } : {}),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind: "permanent" | "transient" = isPermanentSyncFailure(msg)
      ? "permanent"
      : "transient";
    // Permanent failures (deactivated TikTok, private Threads, wrong-typed
    // LinkedIn) — flip the account inactive so the daily cron stops trying.
    // Operator sees it on the account list as `isActive=false` with the
    // reason in `lastContentSyncError`.
    await db
      .update(accounts)
      .set({
        lastContentSyncAt: new Date(),
        lastContentSyncError: msg,
        ...(kind === "permanent" ? { isActive: false } : {}),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
    result.errorMessage = msg;
    result.errorKind = kind;
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
