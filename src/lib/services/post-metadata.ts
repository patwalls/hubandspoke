/**
 * Unified URL → post metadata for the "Add from link" create flow.
 *
 * Takes a published-post URL, infers the platform, hits the right SC endpoint,
 * and returns a normalized shape that the create dialog can pre-fill. Every
 * field is best-effort — callers treat nulls as "we couldn't get that, let
 * the user fill it in". Never throws on a recognized URL; unknown URLs come
 * back as `{ platform: null, ... }` so the dialog stays usable.
 */

import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { inferPostTypeFromUrl } from "@/lib/infer-post-type";
import type { Platform } from "@/lib/platforms";
import type { PostType } from "@/lib/platform-field-schemas";

export interface LinkMetadata {
  platform: Platform | null;
  postType: PostType | null;
  title: string | null;
  publishedDate: string | null; // YYYY-MM-DD
  views: number | null;
  likes: number | null;
  comments: number | null;
  thumbnail: string | null;
  authorHandle: string | null;
  contentBody: string | null; // caption / description / tweet body
  /** Canonical / cleaned URL (e.g. youtu.be resolved to full youtube.com). */
  normalizedUrl: string;
  /** Free-form note when fetching failed or returned nothing useful. */
  warning: string | null;
}

function emptyMetadata(url: string, warning: string | null = null): LinkMetadata {
  return {
    platform: null,
    postType: null,
    title: null,
    publishedDate: null,
    views: null,
    likes: null,
    comments: null,
    thumbnail: null,
    authorHandle: null,
    contentBody: null,
    normalizedUrl: url,
    warning,
  };
}

function truncateTitle(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function toYmd(d: Date | null): string | null {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

function unixToYmd(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return toYmd(new Date(ts * 1000));
}

function parseRelativeTime(text: string | null | undefined): string | null {
  if (!text) return null;
  const now = new Date();
  const m = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case "second": now.setSeconds(now.getSeconds() - n); break;
    case "minute": now.setMinutes(now.getMinutes() - n); break;
    case "hour": now.setHours(now.getHours() - n); break;
    case "day": now.setDate(now.getDate() - n); break;
    case "week": now.setDate(now.getDate() - n * 7); break;
    case "month": now.setMonth(now.getMonth() - n); break;
    case "year": now.setFullYear(now.getFullYear() - n); break;
  }
  return toYmd(now);
}

function platformFromPostType(pt: PostType | null): Platform | null {
  if (!pt) return null;
  if (pt.startsWith("youtube_")) return "youtube";
  if (pt.startsWith("instagram_")) return "instagram";
  return pt as Platform; // x | tiktok | linkedin | threads | newsletter
}

export async function fetchPostMetadataFromUrl(url: string): Promise<LinkMetadata> {
  const postType = inferPostTypeFromUrl(url);
  const platform = platformFromPostType(postType);

  if (!postType || !platform) {
    return emptyMetadata(url, "Unrecognized URL — fill in fields manually.");
  }

  const base: LinkMetadata = { ...emptyMetadata(url), postType, platform };

  try {
    if (platform === "youtube") {
      return await fetchYouTube(url, base);
    }
    if (platform === "instagram") {
      return await fetchInstagram(url, base);
    }
    if (platform === "x") {
      return await fetchTwitter(url, base);
    }
    if (platform === "tiktok") {
      return await fetchTikTok(url, base);
    }
    if (platform === "threads") {
      return await fetchThreads(url, base);
    }
    if (platform === "linkedin") {
      return await fetchLinkedIn(url, base);
    }
  } catch (err) {
    if (err instanceof ScrapeCreatorsError) {
      return { ...base, warning: `SC fetch failed (${err.status}) — fields left empty.` };
    }
    return {
      ...base,
      warning: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ...base, warning: "No fetcher for this platform yet — fill in manually." };
}

/* ------------------------------------------------------------------ */
/*  Per-platform fetchers                                              */
/* ------------------------------------------------------------------ */

interface SCYouTubeVideoResponse {
  id?: string;
  url?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  viewCountInt?: number;
  likeCountInt?: number;
  commentCountInt?: number;
  publishedTime?: string; // ISO
  publishedTimeText?: string; // "3 days ago"
  channel?: { title?: string; handle?: string; customUrl?: string } | null;
}

async function fetchYouTube(url: string, base: LinkMetadata): Promise<LinkMetadata> {
  // Community posts have their own SC endpoint + very different shape.
  if (base.postType === "youtube_community") {
    const data = await scFetchJson<{ likeCount?: number; contentText?: string | null }>(
      "/v1/youtube/community-post",
      { url }
    );
    if (!data) return { ...base, warning: "Post not found on SC — manual entry." };
    return {
      ...base,
      title: truncateTitle(data.contentText),
      likes: data.likeCount ?? null,
      contentBody: data.contentText ?? null,
    };
  }

  const data = await scFetchJson<SCYouTubeVideoResponse>("/v1/youtube/video", { url });
  if (!data) return { ...base, warning: "Video not found on SC — manual entry." };

  const publishedDate =
    (data.publishedTime && data.publishedTime.split("T")[0]) ||
    parseRelativeTime(data.publishedTimeText);

  return {
    ...base,
    title: truncateTitle(data.title),
    publishedDate,
    views: data.viewCountInt ?? null,
    likes: data.likeCountInt ?? null,
    comments: data.commentCountInt ?? null,
    thumbnail: data.thumbnail ?? null,
    authorHandle: data.channel?.handle?.replace(/^@/, "") ?? null,
    contentBody: data.description ?? null,
    normalizedUrl: data.url || url,
  };
}

interface SCInstagramPostResponse {
  data?: {
    xdt_shortcode_media?: {
      shortcode?: string;
      taken_at_timestamp?: number;
      video_play_count?: number | null;
      video_view_count?: number | null;
      edge_media_preview_like?: { count?: number };
      edge_media_to_parent_comment?: { count?: number };
      edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
      owner?: { username?: string; full_name?: string };
      display_url?: string;
      display_resources?: Array<{ src: string }>;
      thumbnail_src?: string;
    };
  };
}

async function fetchInstagram(url: string, base: LinkMetadata): Promise<LinkMetadata> {
  const data = await scFetchJson<SCInstagramPostResponse>("/v1/instagram/post", { url });
  const media = data?.data?.xdt_shortcode_media;
  if (!media) return { ...base, warning: "Post not found on SC — manual entry." };

  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text ?? null;
  const thumbCandidates = media.display_resources ?? [];
  const thumbnail =
    thumbCandidates[thumbCandidates.length - 1]?.src ||
    thumbCandidates[0]?.src ||
    media.display_url ||
    media.thumbnail_src ||
    null;

  return {
    ...base,
    title: truncateTitle(caption) ?? "(No caption)",
    publishedDate: unixToYmd(media.taken_at_timestamp ?? null),
    views: media.video_play_count ?? media.video_view_count ?? null,
    likes: media.edge_media_preview_like?.count ?? null,
    comments: media.edge_media_to_parent_comment?.count ?? null,
    thumbnail,
    authorHandle: media.owner?.username ?? null,
    contentBody: caption,
  };
}

interface SCTwitterResponse {
  tweet?: SCTweet;
  data?: SCTweet;
  url?: string;
  rest_id?: string;
  legacy?: SCTweet["legacy"];
  views?: SCTweet["views"];
  core?: SCTweet["core"];
}
interface SCTweet {
  url?: string;
  legacy?: {
    full_text?: string;
    created_at?: string;
    favorite_count?: number;
    reply_count?: number;
    entities?: { media?: Array<{ media_url_https: string }> };
  };
  views?: { count?: string };
  core?: {
    user_results?: {
      result?: { legacy?: { screen_name?: string; name?: string } };
    };
  };
}

async function fetchTwitter(url: string, base: LinkMetadata): Promise<LinkMetadata> {
  const data = await scFetchJson<SCTwitterResponse>("/v1/twitter/tweet", { url });
  if (!data) return { ...base, warning: "Tweet not found on SC — manual entry." };
  // SC wraps the tweet under different keys depending on version; the fetcher
  // in matg-sync falls back to data.data / data itself, so do the same here.
  const tweet: SCTweet = data.tweet ?? data.data ?? (data as SCTweet);
  const legacy = tweet.legacy;
  if (!legacy) return { ...base, warning: "Tweet not found on SC — manual entry." };

  const publishedDate = legacy.created_at
    ? toYmd(new Date(legacy.created_at))
    : null;
  const fullText = legacy.full_text ?? "";
  const handle = tweet.core?.user_results?.result?.legacy?.screen_name ?? null;

  return {
    ...base,
    title: truncateTitle(fullText),
    publishedDate,
    views: tweet.views?.count ? parseInt(tweet.views.count, 10) : null,
    likes: legacy.favorite_count ?? null,
    comments: legacy.reply_count ?? null,
    thumbnail: legacy.entities?.media?.[0]?.media_url_https ?? null,
    authorHandle: handle,
    contentBody: fullText || null,
    normalizedUrl: tweet.url || url,
  };
}

interface SCTikTokResponse {
  aweme_detail?: {
    desc?: string;
    create_time?: number;
    statistics?: {
      play_count?: number;
      digg_count?: number;
      comment_count?: number;
    };
    author?: { unique_id?: string; nickname?: string };
    video?: { cover?: { url_list?: string[] } };
  };
}

async function fetchTikTok(url: string, base: LinkMetadata): Promise<LinkMetadata> {
  const data = await scFetchJson<SCTikTokResponse>("/v2/tiktok/video", { url });
  const detail = data?.aweme_detail;
  if (!detail) return { ...base, warning: "Video not found on SC — manual entry." };
  return {
    ...base,
    title: truncateTitle(detail.desc),
    publishedDate: unixToYmd(detail.create_time ?? null),
    views: detail.statistics?.play_count ?? null,
    likes: detail.statistics?.digg_count ?? null,
    comments: detail.statistics?.comment_count ?? null,
    thumbnail: detail.video?.cover?.url_list?.[0] ?? null,
    authorHandle: detail.author?.unique_id ?? null,
    contentBody: detail.desc ?? null,
  };
}

interface SCThreadsResponse {
  post?: {
    like_count?: number;
    view_counts?: number;
    caption?: { text?: string; created_at?: number };
    taken_at?: number;
    text_post_app_info?: { direct_reply_count?: number };
    user?: { username?: string };
    image_versions2?: { candidates?: Array<{ url: string }> };
  };
}

async function fetchThreads(url: string, base: LinkMetadata): Promise<LinkMetadata> {
  const data = await scFetchJson<SCThreadsResponse>("/v1/threads/post", { url });
  const post = data?.post;
  if (!post) return { ...base, warning: "Post not found on SC — manual entry." };
  const caption = post.caption?.text ?? null;
  const publishedTs = post.taken_at ?? post.caption?.created_at ?? null;
  return {
    ...base,
    title: truncateTitle(caption),
    publishedDate: unixToYmd(publishedTs),
    views: post.view_counts ?? null,
    likes: post.like_count ?? null,
    comments: post.text_post_app_info?.direct_reply_count ?? null,
    thumbnail: post.image_versions2?.candidates?.[0]?.url ?? null,
    authorHandle: post.user?.username ?? null,
    contentBody: caption,
  };
}

interface SCLinkedInResponse {
  likeCount?: number;
  commentCount?: number;
  postedDate?: string;
  postedDateTimestamp?: number;
  text?: string;
  bodyText?: string;
  headline?: string;
  author?: {
    universalName?: string;
    firstName?: string;
    lastName?: string;
  };
  images?: Array<{ url?: string }>;
  success?: boolean;
}

async function fetchLinkedIn(url: string, base: LinkMetadata): Promise<LinkMetadata> {
  const data = await scFetchJson<SCLinkedInResponse>("/v1/linkedin/post", { url });
  if (!data || data.success === false) {
    return { ...base, warning: "Post not found on SC — manual entry." };
  }
  const body = data.text ?? data.bodyText ?? data.headline ?? null;
  const publishedDate =
    (data.postedDate && data.postedDate.split("T")[0]) ||
    (data.postedDateTimestamp
      ? toYmd(new Date(data.postedDateTimestamp))
      : null);
  return {
    ...base,
    title: truncateTitle(body),
    publishedDate,
    likes: data.likeCount ?? null,
    comments: data.commentCount ?? null,
    thumbnail: data.images?.[0]?.url ?? null,
    authorHandle: data.author?.universalName ?? null,
    contentBody: body,
  };
}
