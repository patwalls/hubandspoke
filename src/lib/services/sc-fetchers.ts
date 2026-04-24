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

// ─── Types ────────────────────────────────────────────────────────────────

export interface SCVideoDetail {
  id: string;
  url: string;
  title: string;
  viewCountInt: number;
  likeCountInt: number;
  commentCountInt: number;
  thumbnail?: string;
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
}

export interface SCPostMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

// ─── Fetchers ─────────────────────────────────────────────────────────────

export async function fetchSingleVideo(videoUrl: string): Promise<SCVideoDetail> {
  const url = `${SC_BASE}/v1/youtube/video?url=${encodeURIComponent(videoUrl)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Video detail error (${res.status}): ${await res.text()}`);
  return res.json();
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
  const res = await fetch(url, { headers: customHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Twitter tweet error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  // SC wraps the tweet under different keys depending on version; accept both.
  return data.tweet || data.data || data;
}

/**
 * Fetch a Threads post by URL. 1 SC credit. Normalized to
 * { views, likes, comments } at the boundary.
 */
export async function fetchThreadsPostByUrl(
  postUrl: string,
  customHeaders: HeadersInit = headers()
): Promise<SCPostMetrics | null> {
  const url = `${SC_BASE}/v1/threads/post?url=${encodeURIComponent(postUrl)}`;
  const res = await fetch(url, { headers: customHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Threads post error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const post = data?.post;
  if (!post) return null;
  return {
    views: post.view_counts ?? null,
    likes: post.like_count ?? null,
    comments: post.text_post_app_info?.direct_reply_count ?? null,
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
  const res = await fetch(url, { headers: customHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LinkedIn post error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data?.success === false) return null;
  return {
    views: null,
    likes: data?.likeCount ?? null,
    comments: data?.commentCount ?? null,
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
  const res = await fetch(url, { headers: customHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TikTok video error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const stats = data?.aweme_detail?.statistics;
  if (!stats) return null;
  return {
    views: stats.play_count ?? null,
    likes: stats.digg_count ?? null,
    comments: stats.comment_count ?? null,
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
  const res = await fetch(url, { headers: customHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`YT community post error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (data?.success === false) return null;
  return {
    views: null,
    likes: data?.likeCount ?? null,
    comments: null,
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
  const res = await fetch(url, { headers: customHeaders });
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
  };
}
