/**
 * Multi-platform sync service for MATG.
 *
 * Uses the Scrape Creators API to pull content data from:
 *  - YouTube (long-form videos)
 *  - YouTube Shorts
 *  - Instagram (reels/posts)
 *  - Twitter/X (tweets)
 *
 * Each source is a separate API call (1 credit each).
 * All content is upserted into the production_items table with brand="matg".
 */

import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";

const SC_BASE = "https://api.scrapecreators.com";
const MATG_YT_HANDLE = "MATGpod";
const MATG_IG_HANDLE = "matgpod";
const MATG_TW_HANDLE = "matgpod";

function apiKey() {
  const key = process.env.SCRAPE_CREATORS_API_KEY;
  if (!key) throw new Error("SCRAPE_CREATORS_API_KEY is not set");
  return key;
}

function headers() {
  return { "x-api-key": apiKey() };
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SCVideo {
  type: string;
  id: string;
  url: string;
  title: string;
  description?: string;
  thumbnail: string;
  channel: { title: string; thumbnail: string | null };
  viewCountText: string;
  viewCountInt: number;
  publishedTimeText: string;
  publishedTime?: string;
  lengthText: string;
  lengthSeconds: number;
  badges: string[];
}

interface SCShort {
  type: string;
  id: string;
  url: string;
  title: string;
  viewCountText: string;
  viewCountInt: number;
  description?: string;
  commentCountInt?: number;
  likeCountInt?: number;
  likeCountText?: string;
  publishDate?: string;
  genre?: string;
}

interface SCInstagramPost {
  id: string;
  code: string;
  taken_at: number;
  media_type: number; // 1=photo, 2=video, 8=carousel
  product_type?: string; // "clips" = reel
  like_count: number;
  comment_count: number;
  play_count?: number;
  caption?: { text?: string } | null;
  url?: string;
  image_versions2?: {
    candidates?: Array<{ url: string; width: number; height: number }>;
  };
}

interface SCTweet {
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

export interface SyncResult {
  source: string;
  fetched: number;
  created: number;
  updated: number;
  errors: number;
}

export interface MultiSyncResult {
  sources: SyncResult[];
  totalFetched: number;
  totalCreated: number;
  totalUpdated: number;
  totalErrors: number;
  creditsUsed: number;
}

/* ------------------------------------------------------------------ */
/*  Date helpers                                                       */
/* ------------------------------------------------------------------ */

function parseRelativeTime(text: string): string | null {
  if (!text) return null;
  const now = new Date();
  const match = text.match(
    /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i
  );
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "second":
      now.setSeconds(now.getSeconds() - num);
      break;
    case "minute":
      now.setMinutes(now.getMinutes() - num);
      break;
    case "hour":
      now.setHours(now.getHours() - num);
      break;
    case "day":
      now.setDate(now.getDate() - num);
      break;
    case "week":
      now.setDate(now.getDate() - num * 7);
      break;
    case "month":
      now.setMonth(now.getMonth() - num);
      break;
    case "year":
      now.setFullYear(now.getFullYear() - num);
      break;
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

/* ------------------------------------------------------------------ */
/*  Fetch functions (1 API credit each)                                */
/* ------------------------------------------------------------------ */

export { SC_BASE, headers };
export type { SCVideo, SCShort, SCTweet, SCInstagramPost };

export async function fetchYouTubeChannelVideos(handle: string): Promise<SCVideo[]> {
  const url = `${SC_BASE}/v1/youtube/channel-videos?handle=${handle}&sort=latest`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`YT videos error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.videos || [];
}

export async function fetchYouTubeChannelShorts(handle: string): Promise<SCShort[]> {
  const url = `${SC_BASE}/v1/youtube/channel/shorts?handle=${handle}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`YT shorts error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.shorts || [];
}

// Brand-scoped conveniences. MATG only has one handle; other callers should use
// the generic `fetchYouTubeChannelVideos/Shorts` with the handle they need.
export async function fetchYouTubeVideos(): Promise<SCVideo[]> {
  return fetchYouTubeChannelVideos(MATG_YT_HANDLE);
}

export async function fetchYouTubeShorts(): Promise<SCShort[]> {
  return fetchYouTubeChannelShorts(MATG_YT_HANDLE);
}

export interface SCVideoDetail {
  id: string;
  url: string;
  title: string;
  viewCountInt: number;
  likeCountInt: number;
  commentCountInt: number;
  thumbnail?: string;
}

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

export interface SCInstagramPostMetrics {
  shortcode: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  thumbnail: string | null;
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

async function fetchInstagramPosts(): Promise<SCInstagramPost[]> {
  const url = `${SC_BASE}/v2/instagram/user/posts?handle=${MATG_IG_HANDLE}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`IG posts error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.items || [];
}

async function fetchTwitterTweets(): Promise<SCTweet[]> {
  const url = `${SC_BASE}/v1/twitter/user-tweets?handle=${MATG_TW_HANDLE}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Twitter error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.tweets || [];
}

/* ------------------------------------------------------------------ */
/*  Upsert helpers — keyed by publishedLink (unique URL per content)   */
/* ------------------------------------------------------------------ */

async function getExistingByLinks(
  links: string[]
): Promise<Map<string, string>> {
  if (links.length === 0) return new Map();
  const rows = await db
    .select({ id: productionItems.id, link: productionItems.publishedLink })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "matg"),
        inArray(productionItems.publishedLink, links)
      )
    );
  return new Map(rows.map((r) => [r.link!, r.id]));
}

/* ------------------------------------------------------------------ */
/*  Sync: YouTube Videos                                               */
/* ------------------------------------------------------------------ */

async function syncYouTubeVideos(): Promise<SyncResult> {
  const result: SyncResult = { source: "YouTube", fetched: 0, created: 0, updated: 0, errors: 0 };
  const videos = await fetchYouTubeVideos();
  result.fetched = videos.length;

  const links = videos.map((v) => v.url).filter(Boolean);
  const existingMap = await getExistingByLinks(links);

  for (const video of videos) {
    try {
      const publishedDate = video.publishedTime
        ? video.publishedTime.split("T")[0]
        : parseRelativeTime(video.publishedTimeText);

      const data = {
        title: video.title,
        youtubeUrl: video.url,
        thumbnail: video.thumbnail,
        publishedDate,
        status: "Published" as const,
        platform: ["YouTube"] as string[],
        format: "Business Interview",
        brand: "matg" as const,
        publishedLink: video.url,
        views: video.viewCountInt || 0,
        isExternal: false,
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
      };

      if (existingMap.has(video.url)) {
        await db.update(productionItems).set(data).where(eq(productionItems.id, existingMap.get(video.url)!));
        result.updated++;
      } else {
        await db.insert(productionItems).values({ ...data, youtubeId: video.id });
        result.created++;
      }
    } catch (err) {
      console.error(`Error processing YT video ${video.id}:`, err);
      result.errors++;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Sync: YouTube Shorts                                               */
/* ------------------------------------------------------------------ */

async function syncYouTubeShorts(): Promise<SyncResult> {
  const result: SyncResult = { source: "YouTube Shorts", fetched: 0, created: 0, updated: 0, errors: 0 };
  const shorts = await fetchYouTubeShorts();
  result.fetched = shorts.length;

  const links = shorts.map((s) => s.url).filter(Boolean);
  const existingMap = await getExistingByLinks(links);

  for (const short of shorts) {
    try {
      const publishedDate = short.publishDate
        ? short.publishDate.split("T")[0]
        : null;

      const data = {
        title: short.title,
        youtubeUrl: short.url,
        thumbnail: null as string | null, // shorts don't have thumbnails in API response
        publishedDate,
        status: "Published" as const,
        platform: ["YouTube Shorts"] as string[],
        format: "YouTube Short",
        brand: "matg" as const,
        publishedLink: short.url,
        views: short.viewCountInt || 0,
        likes: short.likeCountInt || null,
        comments: short.commentCountInt || null,
        isExternal: false,
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
      };

      if (existingMap.has(short.url)) {
        await db.update(productionItems).set(data).where(eq(productionItems.id, existingMap.get(short.url)!));
        result.updated++;
      } else {
        await db.insert(productionItems).values({ ...data, youtubeId: short.id });
        result.created++;
      }
    } catch (err) {
      console.error(`Error processing YT short ${short.id}:`, err);
      result.errors++;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Sync: Instagram                                                    */
/* ------------------------------------------------------------------ */

async function syncInstagram(): Promise<SyncResult> {
  const result: SyncResult = { source: "Instagram", fetched: 0, created: 0, updated: 0, errors: 0 };
  const posts = await fetchInstagramPosts();
  result.fetched = posts.length;

  const links = posts.map((p) => p.url || `https://www.instagram.com/p/${p.code}/`).filter(Boolean);
  const existingMap = await getExistingByLinks(links);

  for (const post of posts) {
    try {
      const postUrl = post.url || `https://www.instagram.com/p/${post.code}/`;
      const publishedDate = unixToDate(post.taken_at);
      const caption = typeof post.caption === "object" && post.caption?.text
        ? post.caption.text
        : null;
      const thumbnail = post.image_versions2?.candidates?.[0]?.url || null;

      // Determine platform label
      const isReel = post.product_type === "clips" || post.media_type === 2;
      const platformLabel = isReel ? "Instagram Reel" : "Instagram Post";
      const formatLabel = isReel ? "Instagram Reel" : "Instagram Post";

      const data = {
        title: caption ? caption.slice(0, 120) + (caption.length > 120 ? "..." : "") : "(No caption)",
        thumbnail,
        publishedDate,
        status: "Published" as const,
        platform: [platformLabel] as string[],
        format: formatLabel,
        brand: "matg" as const,
        publishedLink: postUrl,
        views: post.play_count || null,
        likes: post.like_count || null,
        comments: post.comment_count || null,
        isExternal: false,
        updatedAt: new Date(),
      };

      if (existingMap.has(postUrl)) {
        await db.update(productionItems).set(data).where(eq(productionItems.id, existingMap.get(postUrl)!));
        result.updated++;
      } else {
        await db.insert(productionItems).values(data);
        result.created++;
      }
    } catch (err) {
      console.error(`Error processing IG post ${post.code}:`, err);
      result.errors++;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Sync: Twitter/X                                                    */
/* ------------------------------------------------------------------ */

async function syncTwitter(): Promise<SyncResult> {
  const result: SyncResult = { source: "Twitter", fetched: 0, created: 0, updated: 0, errors: 0 };
  const tweets = await fetchTwitterTweets();
  result.fetched = tweets.length;

  const links = tweets.map((t) => t.url).filter(Boolean);
  const existingMap = await getExistingByLinks(links);

  for (const tweet of tweets) {
    try {
      const legacy = tweet.legacy;
      if (!legacy) continue;

      const publishedDate = parseTwitterDate(legacy.created_at);
      const tweetUrl = tweet.url;
      const viewCount = tweet.views?.count ? parseInt(tweet.views.count, 10) : null;
      const thumbnail = legacy.entities?.media?.[0]?.media_url_https || null;

      // Truncate long tweets for title
      const fullText = legacy.full_text || "";
      const title = fullText.length > 120 ? fullText.slice(0, 120) + "..." : fullText;

      const data = {
        title,
        thumbnail,
        publishedDate,
        status: "Published" as const,
        platform: ["Twitter"] as string[],
        format: "Tweet",
        brand: "matg" as const,
        publishedLink: tweetUrl,
        views: viewCount,
        likes: legacy.favorite_count || null,
        comments: legacy.reply_count || null,
        isExternal: false,
        updatedAt: new Date(),
      };

      if (existingMap.has(tweetUrl)) {
        await db.update(productionItems).set(data).where(eq(productionItems.id, existingMap.get(tweetUrl)!));
        result.updated++;
      } else {
        await db.insert(productionItems).values(data);
        result.created++;
      }
    } catch (err) {
      console.error(`Error processing tweet ${tweet.rest_id}:`, err);
      result.errors++;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Main: sync all platforms                                           */
/* ------------------------------------------------------------------ */

export async function syncAllMATG(): Promise<MultiSyncResult> {
  const startedAt = new Date();
  const sources: SyncResult[] = [];
  let creditsUsed = 0;

  // Run each sync, catching errors per-source so one failure doesn't block others
  // NOTE: Instagram and Twitter are currently inactive for MATG — re-add when they start posting again
  const syncFns: Array<{ name: string; fn: () => Promise<SyncResult> }> = [
    { name: "YouTube", fn: syncYouTubeVideos },
    { name: "YouTube Shorts", fn: syncYouTubeShorts },
    // { name: "Instagram", fn: syncInstagram },
    // { name: "Twitter", fn: syncTwitter },
  ];

  for (const { name, fn } of syncFns) {
    try {
      const result = await fn();
      sources.push(result);
      creditsUsed++;
    } catch (err) {
      console.error(`${name} sync failed:`, err);
      sources.push({
        source: name,
        fetched: 0,
        created: 0,
        updated: 0,
        errors: 1,
      });
      creditsUsed++; // API call was still made even if it errored
    }
  }

  const totalFetched = sources.reduce((s, r) => s + r.fetched, 0);
  const totalCreated = sources.reduce((s, r) => s + r.created, 0);
  const totalUpdated = sources.reduce((s, r) => s + r.updated, 0);
  const totalErrors = sources.reduce((s, r) => s + r.errors, 0);

  // Log sync
  await db.insert(syncLogs).values({
    syncType: "matg-all",
    status: totalErrors > 0 && totalFetched === 0 ? "error" : "success",
    itemsFetched: totalFetched,
    itemsCreated: totalCreated,
    itemsUpdated: totalUpdated,
    startedAt,
    completedAt: new Date(),
  });

  return { sources, totalFetched, totalCreated, totalUpdated, totalErrors, creditsUsed };
}

/**
 * Legacy function — syncs only YouTube videos (1 credit).
 * Keep for backward compatibility.
 */
export async function syncMATGYouTube() {
  const startedAt = new Date();
  try {
    const result = await syncYouTubeVideos();
    await db.insert(syncLogs).values({
      syncType: "youtube-matg",
      status: "success",
      itemsFetched: result.fetched,
      itemsCreated: result.created,
      itemsUpdated: result.updated,
      startedAt,
      completedAt: new Date(),
    });
    return {
      videosFetched: result.fetched,
      created: result.created,
      updated: result.updated,
      errors: result.errors,
    };
  } catch (err) {
    await db.insert(syncLogs).values({
      syncType: "youtube-matg",
      status: "error",
      errorMessage: String(err),
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }
}
