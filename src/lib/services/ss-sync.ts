/**
 * Starter Story multi-platform sync service.
 *
 * Uses the Scrape Creators API (Pat's account) to pull fresh metrics
 * from all SS channels: YouTube, Instagram, and Twitter/X.
 *
 * Only UPDATES existing production items — Notion is the source of truth
 * for content discovery. This service just keeps metrics fresh.
 *
 * ~5 API credits per run.
 */

import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { needsPerformanceSync } from "./performance-decay";
import {
  fetchSingleVideo,
  fetchTweetByUrl,
  fetchInstagramPostByUrl,
} from "./matg-sync";

const SC_BASE = "https://api.scrapecreators.com";
const MAX_CREDITS_PER_RUN = 10;

// --- SS Handles ---
const SS_YT_HANDLES = ["starterstory", "StarterStoryBuild"];
const SS_IG_HANDLE = "starter_story";
const SS_TW_HANDLES = ["thepatwalls", "starterstory"];

function ssApiKey() {
  const key = process.env.SC_API_KEY_SS || process.env.SCRAPE_CREATORS_API_KEY;
  if (!key) throw new Error("SC_API_KEY_SS or SCRAPE_CREATORS_API_KEY must be set");
  return key;
}

function ssHeaders() {
  return { "x-api-key": ssApiKey() };
}

// Extract YouTube video ID from any YT URL format
const YT_ID_REGEX = /(?:v=|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/;

function extractYouTubeId(url: string): string | null {
  const match = url.match(YT_ID_REGEX);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SCChannelVideo {
  id: string;
  url: string;
  title: string;
  viewCountInt: number;
  thumbnail?: string;
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

interface SCTweet {
  __typename: string;
  rest_id: string;
  url: string;
  legacy: {
    full_text: string;
    created_at: string;
    favorite_count: number;
    retweet_count: number;
    reply_count: number;
    bookmark_count: number;
    id_str: string;
    entities?: {
      media?: Array<{ media_url_https: string }>;
    };
  };
  views?: { count?: string };
}

interface SourceSyncResult {
  source: string;
  fetched: number;
  matched: number;
  updated: number;
  errors: string[];
}

export interface SSSyncResult {
  sources: SourceSyncResult[];
  creditsUsed: number;
  totalFetched: number;
  totalMatched: number;
  totalUpdated: number;
  errors: string[];
}

/* ------------------------------------------------------------------ */
/*  URL matching helpers                                               */
/* ------------------------------------------------------------------ */

// Normalize URLs for matching (strip protocol, www, trailing slash)
function normalizeUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  YouTube sync                                                       */
/* ------------------------------------------------------------------ */

async function syncYouTube(
  creditsUsed: number
): Promise<{ result: SourceSyncResult; creditsUsed: number }> {
  const result: SourceSyncResult = {
    source: "YouTube",
    fetched: 0,
    matched: 0,
    updated: 0,
    errors: [],
  };

  // Fetch from both YT channels
  const apiVideos = new Map<string, { views: number; thumbnail?: string; url: string }>();

  for (const handle of SS_YT_HANDLES) {
    if (creditsUsed >= MAX_CREDITS_PER_RUN) break;

    try {
      const url = `${SC_BASE}/v1/youtube/channel-videos?handle=${handle}&sort=latest`;
      const res = await fetch(url, { headers: ssHeaders() });
      creditsUsed++;

      if (!res.ok) {
        result.errors.push(`YT ${handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const videos: SCChannelVideo[] = data.videos || [];
      result.fetched += videos.length;

      for (const video of videos) {
        const ytId = extractYouTubeId(video.url) || video.id;
        if (ytId) {
          apiVideos.set(ytId, {
            views: video.viewCountInt || 0,
            thumbnail: video.thumbnail,
            url: video.url,
          });
        }
      }
    } catch (err) {
      result.errors.push(`YT ${handle}: ${String(err)}`);
    }
  }

  // Match to existing SS production items
  const ssItems = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      youtubeId: productionItems.youtubeId,
      youtubeUrl: productionItems.youtubeUrl,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "starter-story"),
        eq(productionItems.status, "Published")
      )
    );

  for (const item of ssItems) {
    const urls = [item.publishedLink, item.youtubeUrl].filter(Boolean) as string[];
    let matchedYtId: string | null = item.youtubeId || null;

    if (!matchedYtId) {
      for (const url of urls) {
        matchedYtId = extractYouTubeId(url);
        if (matchedYtId) break;
      }
    }

    if (!matchedYtId || !apiVideos.has(matchedYtId)) continue;

    result.matched++;
    const apiData = apiVideos.get(matchedYtId)!;

    try {
      await db
        .update(productionItems)
        .set({
          views: apiData.views,
          thumbnail: apiData.thumbnail || undefined,
          youtubeId: matchedYtId,
          youtubeUrl: apiData.url,
          lastPerformanceSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, item.id));
      result.updated++;
    } catch (err) {
      result.errors.push(`YT update ${item.id}: ${String(err)}`);
    }
  }

  return { result, creditsUsed };
}

/* ------------------------------------------------------------------ */
/*  Instagram sync                                                     */
/* ------------------------------------------------------------------ */

async function syncInstagram(
  creditsUsed: number
): Promise<{ result: SourceSyncResult; creditsUsed: number }> {
  const result: SourceSyncResult = {
    source: "Instagram",
    fetched: 0,
    matched: 0,
    updated: 0,
    errors: [],
  };

  if (creditsUsed >= MAX_CREDITS_PER_RUN) return { result, creditsUsed };

  try {
    const url = `${SC_BASE}/v2/instagram/user/posts?handle=${SS_IG_HANDLE}`;
    const res = await fetch(url, { headers: ssHeaders() });
    creditsUsed++;

    if (!res.ok) {
      result.errors.push(`IG ${SS_IG_HANDLE}: HTTP ${res.status}`);
      return { result, creditsUsed };
    }

    const data = await res.json();
    const posts: SCInstagramPost[] = data.items || [];
    result.fetched = posts.length;

    // Build URL → metrics map
    const apiPosts = new Map<
      string,
      { views: number | null; likes: number | null; comments: number | null; thumbnail: string | null }
    >();

    for (const post of posts) {
      const postUrl = post.url || `https://www.instagram.com/p/${post.code}/`;
      const thumbnail = post.image_versions2?.candidates?.[0]?.url || null;
      apiPosts.set(normalizeUrl(postUrl), {
        views: post.play_count || null,
        likes: post.like_count || null,
        comments: post.comment_count || null,
        thumbnail,
      });
    }

    // Match to existing SS items by published link
    const ssItems = await db
      .select({
        id: productionItems.id,
        publishedLink: productionItems.publishedLink,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, "starter-story"),
          eq(productionItems.status, "Published")
        )
      );

    for (const item of ssItems) {
      if (!item.publishedLink) continue;
      const normalized = normalizeUrl(item.publishedLink);
      if (!normalized.includes("instagram.com")) continue;

      const apiData = apiPosts.get(normalized);
      if (!apiData) continue;

      result.matched++;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updateData: Record<string, any> = {
          lastPerformanceSyncAt: new Date(),
          updatedAt: new Date(),
        };
        if (apiData.views != null) updateData.views = apiData.views;
        if (apiData.likes != null) updateData.likes = apiData.likes;
        if (apiData.comments != null) updateData.comments = apiData.comments;
        if (apiData.thumbnail) updateData.thumbnail = apiData.thumbnail;

        await db
          .update(productionItems)
          .set(updateData)
          .where(eq(productionItems.id, item.id));
        result.updated++;
      } catch (err) {
        result.errors.push(`IG update ${item.id}: ${String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(`IG: ${String(err)}`);
  }

  return { result, creditsUsed };
}

/* ------------------------------------------------------------------ */
/*  Twitter/X sync                                                     */
/* ------------------------------------------------------------------ */

async function syncTwitter(
  creditsUsed: number
): Promise<{ result: SourceSyncResult; creditsUsed: number }> {
  const result: SourceSyncResult = {
    source: "Twitter",
    fetched: 0,
    matched: 0,
    updated: 0,
    errors: [],
  };

  // Build URL → metrics map from all Twitter handles
  const apiTweets = new Map<
    string,
    { views: number | null; likes: number | null; comments: number | null }
  >();

  for (const handle of SS_TW_HANDLES) {
    if (creditsUsed >= MAX_CREDITS_PER_RUN) break;

    try {
      const url = `${SC_BASE}/v1/twitter/user-tweets?handle=${handle}`;
      const res = await fetch(url, { headers: ssHeaders() });
      creditsUsed++;

      if (!res.ok) {
        result.errors.push(`TW ${handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const tweets: SCTweet[] = data.tweets || [];
      result.fetched += tweets.length;

      for (const tweet of tweets) {
        if (!tweet.url || !tweet.legacy) continue;
        const viewCount = tweet.views?.count ? parseInt(tweet.views.count, 10) : null;
        apiTweets.set(normalizeUrl(tweet.url), {
          views: viewCount,
          likes: tweet.legacy.favorite_count || null,
          comments: tweet.legacy.reply_count || null,
        });
      }
    } catch (err) {
      result.errors.push(`TW ${handle}: ${String(err)}`);
    }
  }

  // Match to existing SS items
  const ssItems = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "starter-story"),
        eq(productionItems.status, "Published")
      )
    );

  for (const item of ssItems) {
    if (!item.publishedLink) continue;
    const normalized = normalizeUrl(item.publishedLink);
    if (!normalized.includes("x.com") && !normalized.includes("twitter.com")) continue;

    const apiData = apiTweets.get(normalized);
    if (!apiData) continue;

    result.matched++;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateData: Record<string, any> = {
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
      };
      if (apiData.views != null) updateData.views = apiData.views;
      if (apiData.likes != null) updateData.likes = apiData.likes;
      if (apiData.comments != null) updateData.comments = apiData.comments;

      await db
        .update(productionItems)
        .set(updateData)
        .where(eq(productionItems.id, item.id));
      result.updated++;
    } catch (err) {
      result.errors.push(`TW update ${item.id}: ${String(err)}`);
    }
  }

  return { result, creditsUsed };
}

/* ------------------------------------------------------------------ */
/*  Main: sync all SS platforms                                        */
/* ------------------------------------------------------------------ */

export async function syncSSViews(): Promise<SSSyncResult> {
  const startedAt = new Date();
  const finalResult: SSSyncResult = {
    sources: [],
    creditsUsed: 0,
    totalFetched: 0,
    totalMatched: 0,
    totalUpdated: 0,
    errors: [],
  };

  try {
    let credits = 0;

    // YouTube (2 credits — 2 channels)
    const yt = await syncYouTube(credits);
    finalResult.sources.push(yt.result);
    credits = yt.creditsUsed;

    // Instagram (1 credit)
    const ig = await syncInstagram(credits);
    finalResult.sources.push(ig.result);
    credits = ig.creditsUsed;

    // Twitter/X (2 credits — 2 handles)
    const tw = await syncTwitter(credits);
    finalResult.sources.push(tw.result);
    credits = tw.creditsUsed;

    finalResult.creditsUsed = credits;
    finalResult.totalFetched = finalResult.sources.reduce((s, r) => s + r.fetched, 0);
    finalResult.totalMatched = finalResult.sources.reduce((s, r) => s + r.matched, 0);
    finalResult.totalUpdated = finalResult.sources.reduce((s, r) => s + r.updated, 0);
    finalResult.errors = finalResult.sources.flatMap((r) => r.errors);

    // Log sync
    await db.insert(syncLogs).values({
      syncType: "ss-all-platforms",
      status: finalResult.errors.length > 0 && finalResult.totalUpdated === 0 ? "error" : "success",
      itemsFetched: finalResult.totalFetched,
      itemsUpdated: finalResult.totalUpdated,
      errorMessage: finalResult.errors.length > 0 ? finalResult.errors.join("; ") : null,
      startedAt,
      completedAt: new Date(),
    });

    return finalResult;
  } catch (err) {
    await db.insert(syncLogs).values({
      syncType: "ss-all-platforms",
      status: "error",
      errorMessage: String(err),
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }
}

// Keep backward-compatible export name
export const syncSSYouTubeViews = syncSSViews;

/* ------------------------------------------------------------------ */
/*  Smart-gated multi-platform refresh                                 */
/* ------------------------------------------------------------------ */

type PlatformKind = "youtube" | "instagram" | "twitter";

// Coarse platform bucket derived from an item's platform[] array.
function platformKindsFor(platforms: string[] | null): Set<PlatformKind> {
  const out = new Set<PlatformKind>();
  for (const p of platforms || []) {
    if (p.includes("YouTube")) out.add("youtube");
    else if (p.includes("Instagram")) out.add("instagram");
    else if (p === "Twitter" || p === "X") out.add("twitter");
  }
  return out;
}

// Per-run credit cap for the cron loop. Tune via SC_MAX_CREDITS_PER_RUN.
// At hourly cadence, 30 = 720/day worst case across IG + Twitter combined.
const CRON_MAX_CREDITS = Number(process.env.SC_MAX_CREDITS_PER_RUN) || 30;

interface DueItemRow {
  id: string;
  kinds: Set<PlatformKind>;
  reason: string;
}

// Find every SS Published item whose decay tier says it's due for a refresh.
// One row per DB item (not per platform) — we let `refreshItemMetrics` pick
// the right endpoint from the item's platform[] at call time.
async function dueSSItems(): Promise<DueItemRow[]> {
  const rows = await db
    .select({
      id: productionItems.id,
      publishedDate: productionItems.publishedDate,
      lastPerformanceSyncAt: productionItems.lastPerformanceSyncAt,
      platform: productionItems.platform,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "starter-story"),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.publishedDate)
      )
    );

  const due: DueItemRow[] = [];
  for (const r of rows) {
    const check = needsPerformanceSync({
      publishedDate: r.publishedDate,
      lastPerformanceSyncAt: r.lastPerformanceSyncAt,
    });
    if (!check.needsSync) continue;
    const kinds = platformKindsFor(r.platform as string[] | null);
    // YouTube items are owned by `performance-decay` — don't double-refresh.
    kinds.delete("youtube");
    if (kinds.size === 0) continue;
    due.push({ id: r.id, kinds, reason: check.reason });
  }
  // Oldest-sync-first would require returning the timestamp; for now the
  // natural DB order is fine — freshly-inserted rows (sync=null) tend to
  // come first. If we later see starvation on busy days, sort by
  // lastPerformanceSyncAt nulls-first, ascending.
  return due;
}

/**
 * Smart per-item SS metrics refresh for the hourly cron. Iterates due items
 * (per the shared decay tiers) and calls the Scrape Creators direct-URL
 * endpoint for each. Stops once `CRON_MAX_CREDITS` credits have been spent.
 *
 * YouTube items are skipped — `performance-decay` already owns YouTube via
 * its own per-URL + channel-bulk flow.
 */
export async function smartSyncSSMetrics(): Promise<SSSyncResult> {
  const startedAt = new Date();
  const finalResult: SSSyncResult = {
    sources: [],
    creditsUsed: 0,
    totalFetched: 0,
    totalMatched: 0,
    totalUpdated: 0,
    errors: [],
  };

  const perPlatform: Record<PlatformKind, SourceSyncResult> = {
    youtube: { source: "YouTube", fetched: 0, matched: 0, updated: 0, errors: [] },
    instagram: { source: "Instagram", fetched: 0, matched: 0, updated: 0, errors: [] },
    twitter: { source: "Twitter", fetched: 0, matched: 0, updated: 0, errors: [] },
  };

  try {
    const due = await dueSSItems();
    let credits = 0;

    for (const item of due) {
      if (credits >= CRON_MAX_CREDITS) {
        finalResult.errors.push(`credit cap hit at ${credits} — ${due.length - finalResult.totalMatched} items deferred`);
        break;
      }
      try {
        const r = await refreshItemMetrics(item.id);
        credits += r.creditsUsed;
        const bucket = perPlatform[r.platform === "unknown" ? "twitter" : r.platform];
        bucket.fetched++;
        if (r.updated) {
          bucket.matched++;
          bucket.updated++;
        } else if (r.note) {
          bucket.errors.push(`${item.id}: ${r.note}`);
        }
      } catch (err) {
        // Best-effort: don't let one bad item kill the whole run.
        const msg = err instanceof Error ? err.message : String(err);
        // Attribute to whichever platform the item claimed so the log is useful.
        const kind: PlatformKind = item.kinds.has("twitter")
          ? "twitter"
          : item.kinds.has("instagram")
            ? "instagram"
            : "youtube";
        perPlatform[kind].errors.push(`${item.id}: ${msg}`);
        // Still count the credit if the call went out; we can't tell from here
        // so assume it did to stay safely under the cap.
        credits += 1;
      }
      finalResult.totalMatched++;
    }

    finalResult.sources = [perPlatform.instagram, perPlatform.twitter];
    finalResult.creditsUsed = credits;
    finalResult.totalFetched = finalResult.sources.reduce((s, r) => s + r.fetched, 0);
    finalResult.totalUpdated = finalResult.sources.reduce((s, r) => s + r.updated, 0);
    finalResult.errors.push(...finalResult.sources.flatMap((r) => r.errors));

    await db.insert(syncLogs).values({
      syncType: "ss-metrics-sync",
      status: finalResult.totalUpdated === 0 && finalResult.errors.length > 0 ? "error" : "success",
      itemsFetched: finalResult.totalFetched,
      itemsUpdated: finalResult.totalUpdated,
      errorMessage: finalResult.errors.length > 0 ? finalResult.errors.slice(0, 5).join("; ") : null,
      startedAt,
      completedAt: new Date(),
    });

    return finalResult;
  } catch (err) {
    await db.insert(syncLogs).values({
      syncType: "ss-metrics-sync",
      status: "error",
      errorMessage: String(err),
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  Per-item refresh (powers the UI button + the decay cron loop)      */
/* ------------------------------------------------------------------ */

export interface RefreshItemResult {
  itemId: string;
  updated: boolean;
  platform: "youtube" | "instagram" | "twitter" | "unknown";
  views: number | null;
  likes: number | null;
  comments: number | null;
  note?: string;
  creditsUsed: number;
}

/**
 * Refresh a single production item's metrics by hitting the appropriate
 * Scrape Creators URL endpoint directly. 1 credit per call (0 if the
 * platform/URL isn't supported). Writes `lastPerformanceSyncAt` on success
 * so the decay gate sees it as fresh.
 *
 * Uses URL-based endpoints across all platforms — no timeline/feed matching,
 * so it works regardless of how old the post is or whether it's still on the
 * author's recent timeline.
 */
export async function refreshItemMetrics(itemId: string): Promise<RefreshItemResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      platform: productionItems.platform,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) {
    throw new Error(`Item not found: ${itemId}`);
  }

  const url = item.publishedLink || item.youtubeUrl || "";
  const kinds = platformKindsFor(item.platform as string[] | null);

  // --- YouTube: per-video endpoint (exact match, 1 credit) ---
  if (kinds.has("youtube") && url) {
    const detail = await fetchSingleVideo(url);
    const views = detail.viewCountInt ?? null;
    const likes = detail.likeCountInt ?? null;
    const comments = detail.commentCountInt ?? null;
    await db
      .update(productionItems)
      .set({
        views: views ?? 0,
        likes,
        comments,
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "youtube",
      views,
      likes,
      comments,
      creditsUsed: 1,
    };
  }

  // --- Twitter: direct-URL tweet endpoint (no handle lookup needed) ---
  if (kinds.has("twitter") && url) {
    const tweet = await fetchTweetByUrl(url, ssHeaders());
    if (!tweet || !tweet.legacy) {
      return {
        itemId,
        updated: false,
        platform: "twitter",
        views: null,
        likes: null,
        comments: null,
        note: tweet ? "Tweet response missing engagement fields" : "Tweet not found at URL",
        creditsUsed: 1,
      };
    }
    const views = tweet.views?.count ? parseInt(tweet.views.count, 10) : null;
    const likes = tweet.legacy.favorite_count ?? null;
    const comments = tweet.legacy.reply_count ?? null;
    await db
      .update(productionItems)
      .set({
        ...(views != null && { views }),
        ...(likes != null && { likes }),
        ...(comments != null && { comments }),
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "twitter",
      views,
      likes,
      comments,
      creditsUsed: 1,
    };
  }

  // --- Instagram: direct-URL post/reel endpoint ---
  if (kinds.has("instagram") && url) {
    const post = await fetchInstagramPostByUrl(url, ssHeaders());
    if (!post) {
      return {
        itemId,
        updated: false,
        platform: "instagram",
        views: null,
        likes: null,
        comments: null,
        note: "Post not found at URL",
        creditsUsed: 1,
      };
    }
    const { views, likes, comments, thumbnail } = post;
    await db
      .update(productionItems)
      .set({
        ...(views != null && { views }),
        ...(likes != null && { likes }),
        ...(comments != null && { comments }),
        ...(thumbnail && { thumbnail }),
        lastPerformanceSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "instagram",
      views,
      likes,
      comments,
      creditsUsed: 1,
    };
  }

  return {
    itemId,
    updated: false,
    platform: "unknown",
    views: null,
    likes: null,
    comments: null,
    note: "Platform not supported or missing URL",
    creditsUsed: 0,
  };
}
