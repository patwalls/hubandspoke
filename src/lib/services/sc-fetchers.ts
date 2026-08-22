/**
 * ScrapeCreators single-URL fetchers. Each helper hits one SC endpoint for
 * one known piece of content (a specific video / post / tweet) and returns
 * a normalized shape for the caller.
 *
 * These are the "enrich one row" calls — distinct from the bulk
 * per-account content pullers in `account-content-sync.ts`, which paginate
 * through a user's timeline. The performance-decay sweep, the "add from
 * link" preview flow, and the tweet-body-fetch job all live on this side.
 *
 * This module used to live inside `matg-sync.ts`, alongside the MATG
 * bulk-sync code. When the bulk sync was generalized into the per-account
 * sync service, these helpers were broken out so the deletion of the
 * MATG-specific module wouldn't take enrichment / performance-decay down
 * with it.
 */

import { SC_BASE, headers } from "@/lib/services/sc-client";

// ─── Network budget ───────────────────────────────────────────────────────
// Every fetch below is a bare outbound call to a third-party host, made from
// the worker dyno — which, unlike the web dyno, has no router timeout to bail
// it out. Without an explicit signal a stalled SC connection hangs the awaiting
// job *forever*: on 2026-08-22 two consecutive hourly `performance-decay` runs
// (19:00 and 20:00 UTC) never returned, and since the worker runs concurrency=2
// the second hang wedged the whole dyno — no heartbeat, no jobs drained, 206
// queued. Normal runs of that sweep finish in 52-452s, so a per-request budget
// well above the slow tail still fails fast against a black hole.
// Mirrors PULSE_TIMEOUT_MS in pulse-client.ts, the one fetch path that already
// had a budget (and, notably, the one that never hung).
const SC_TIMEOUT_MS = 30_000;

function scSignal(): AbortSignal {
  return AbortSignal.timeout(SC_TIMEOUT_MS);
}

// ─── Date helpers ─────────────────────────────────────────────────────────
// Most SC endpoints carry the publish timestamp as either a unix-seconds
// integer or a parseable date string. Normalize both to ISO-8601 here so
// every fetcher returns the same shape downstream.

function unixToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface SCVideoDetail {
  id: string;
  url: string;
  title: string;
  viewCountInt: number;
  likeCountInt: number;
  commentCountInt: number;
  thumbnail?: string;
  publishedAt: string | null;
}

export interface SCTweet {
  __typename: string;
  rest_id: string;
  url: string;
  legacy: {
    full_text: string;
    created_at: string; // "Tue May 07 16:47:33 +0000 2024"
    favorite_count: number;
    retweet_count: number;
    reply_count: number;
    bookmark_count: number;
    id_str: string;
    entities?: {
      media?: Array<{ media_url_https: string }>;
    };
  };
  views?: { count?: string; state?: string };
}

export interface SCInstagramPostMetrics {
  shortcode: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  thumbnail: string | null;
  publishedAt: string | null;
}

export interface SCPostMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  publishedAt: string | null;
}

// ─── Fetchers ─────────────────────────────────────────────────────────────

export async function fetchSingleVideo(videoUrl: string): Promise<SCVideoDetail> {
  const url = `${SC_BASE}/v1/youtube/video?url=${encodeURIComponent(videoUrl)}`;
  const res = await fetch(url, { headers: headers(), signal: scSignal() });
  if (!res.ok) throw new Error(`Video detail error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  // SC returns publishedTime / publishDate depending on shape — accept either.
  const publishRaw =
    typeof data.publishedTime === "string" ? data.publishedTime
    : typeof data.publishDate === "string" ? data.publishDate
    : null;
  return { ...data, publishedAt: toIsoOrNull(publishRaw) };
}

/**
 * Fetch a single tweet's full payload by URL. Works for any tweet — does not
 * require it to be on a particular user's recent timeline. 1 SC credit.
 * Accepts custom headers so SS's brand-scoped API key can be used here too.
 */
export async function fetchTweetByUrl(
  tweetUrl: string,
  customHeaders: HeadersInit = headers()
): Promise<SCTweet | null> {
  const url = `${SC_BASE}/v1/twitter/tweet?url=${encodeURIComponent(tweetUrl)}`;
  const res = await fetch(url, { headers: customHeaders, signal: scSignal() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Twitter tweet error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  // SC wraps the tweet under different keys depending on version; accept both.
  return data.tweet || data.data || data;
}

/**
 * Fetch a Threads post by URL. 1 SC credit. Normalized to
 * { views, likes, comments } at the boundary.
 *
 * `views` is intentionally always null. SC's `post.view_counts` field for
 * Threads is unreliable — it under-reports fresh posts (we've seen 342
 * views on a post with 137 likes, while the actual Threads UI showed
 * thousands). The caller estimates views from likes via the 150× Threads
 * multiplier in view-estimator.ts — same pattern as LinkedIn.
 */
export async function fetchThreadsPostByUrl(
  postUrl: string,
  customHeaders: HeadersInit = headers()
): Promise<SCPostMetrics | null> {
  const url = `${SC_BASE}/v1/threads/post?url=${encodeURIComponent(postUrl)}`;
  const res = await fetch(url, { headers: customHeaders, signal: scSignal() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Threads post error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const post = data?.post;
  if (!post) return null;
  return {
    views: null,
    likes: post.like_count ?? null,
    comments: post.text_post_app_info?.direct_reply_count ?? null,
    publishedAt: unixToIso(post.taken_at),
  };
}

/**
 * Fetch a LinkedIn post by URL. 1 SC credit. Views are not returned by SC
 * for LinkedIn so we leave that column alone at the caller.
 */
export async function fetchLinkedInPostByUrl(
  postUrl: string,
  customHeaders: HeadersInit = headers()
): Promise<SCPostMetrics | null> {
  const url = `${SC_BASE}/v1/linkedin/post?url=${encodeURIComponent(postUrl)}`;
  const res = await fetch(url, { headers: customHeaders, signal: scSignal() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LinkedIn post error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data?.success === false) return null;
  // SC's posted_at.timestamp is a millisecond epoch; some shapes expose
  // postedAtTimestamp directly. Tolerate both.
  const ms =
    typeof data?.posted_at?.timestamp === "number" ? data.posted_at.timestamp
    : typeof data?.postedAtTimestamp === "number" ? data.postedAtTimestamp
    : null;
  return {
    views: null,
    likes: data?.likeCount ?? null,
    comments: data?.commentCount ?? null,
    publishedAt: ms ? new Date(ms).toISOString() : null,
  };
}

/**
 * Fetch a TikTok video by URL. 1 SC credit. SC returns real play / like /
 * comment counts in `aweme_detail.statistics`, so no view-estimation needed.
 */
export async function fetchTikTokVideoByUrl(
  videoUrl: string,
  customHeaders: HeadersInit = headers()
): Promise<SCPostMetrics | null> {
  const url = `${SC_BASE}/v2/tiktok/video?url=${encodeURIComponent(videoUrl)}`;
  const res = await fetch(url, { headers: customHeaders, signal: scSignal() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TikTok video error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const stats = data?.aweme_detail?.statistics;
  if (!stats) return null;
  return {
    views: stats.play_count ?? null,
    likes: stats.digg_count ?? null,
    comments: stats.comment_count ?? null,
    publishedAt: unixToIso(data?.aweme_detail?.create_time),
  };
}

/**
 * Fetch a YouTube community post by URL. 1 SC credit. Only likes are
 * returned by SC — views and comments stay untouched at the caller.
 */
export async function fetchYouTubeCommunityPostByUrl(
  postUrl: string,
  customHeaders: HeadersInit = headers()
): Promise<SCPostMetrics | null> {
  const url = `${SC_BASE}/v1/youtube/community-post?url=${encodeURIComponent(postUrl)}`;
  const res = await fetch(url, { headers: customHeaders, signal: scSignal() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`YT community post error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data?.success === false) return null;
  // SC's community-post endpoint typically only returns a relative-time
  // string ("2 weeks ago"), not a precise timestamp. Skip — better to leave
  // publishedDate NULL than guess from a fuzzy field.
  return {
    views: null,
    likes: data?.likeCount ?? null,
    comments: null,
    publishedAt: null,
  };
}

/**
 * Fetch a single Instagram post/reel by URL. Response is `xdt_shortcode_media`
 * shape, different from the bulk user/posts endpoint — we normalize it here.
 * 1 SC credit.
 */
export async function fetchInstagramPostByUrl(
  postUrl: string,
  customHeaders: HeadersInit = headers()
): Promise<SCInstagramPostMetrics | null> {
  const url = `${SC_BASE}/v1/instagram/post?url=${encodeURIComponent(postUrl)}`;
  const res = await fetch(url, { headers: customHeaders, signal: scSignal() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`IG post error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const media = data?.data?.xdt_shortcode_media;
  if (!media) return null;
  const thumbnailCandidates = media.display_resources || [];
  const thumbnail =
    thumbnailCandidates[thumbnailCandidates.length - 1]?.src ||
    thumbnailCandidates[0]?.src ||
    media.display_url ||
    null;
  return {
    shortcode: media.shortcode || "",
    views: media.video_play_count ?? media.video_view_count ?? null,
    likes: media.edge_media_preview_like?.count ?? null,
    comments: media.edge_media_to_parent_comment?.count ?? null,
    thumbnail,
    publishedAt: unixToIso(media.taken_at_timestamp),
  };
}
