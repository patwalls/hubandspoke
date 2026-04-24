/**
 * Performance Data Decay Service — unified metrics refresh.
 *
 * Single entry point for pulling fresh views / likes / comments from Scrape
 * Creators across every supported platform. Brand-agnostic; URL-based (one SC
 * credit per item); decay-tier gated so archival items don't burn credits.
 *
 * Decay tiers (based on content age since publishedDate):
 *   Fresh    (< 24h)   → every 1 hour    (catches early engagement curve)
 *   Recent   (1–7d)    → every 6 hours
 *   Active   (8–28d)   → daily
 *   Mature   (29–90d)  → every 3 days
 *   Aging    (91–180d) → weekly
 *   Archived (180d+)   → monthly
 *
 * Supported platforms:
 *   YouTube (video + shorts)    /v1/youtube/video?url=
 *   YouTube Community           /v1/youtube/community-post?url=
 *   Instagram (post + reel)     /v1/instagram/post?url=
 *   Twitter / X                 /v1/twitter/tweet?url=
 *   Threads                     /v1/threads/post?url=
 *   LinkedIn                    /v1/linkedin/post?url=
 *   TikTok                      /v2/tiktok/video?url=
 */

import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  fetchSingleVideo,
  fetchTweetByUrl,
  fetchInstagramPostByUrl,
  fetchThreadsPostByUrl,
  fetchLinkedInPostByUrl,
  fetchYouTubeCommunityPostByUrl,
  fetchTikTokVideoByUrl,
} from "./sc-fetchers";
import { estimateViewsFromLikes } from "./view-estimator";

/* ------------------------------------------------------------------ */
/*  Decay schedule configuration                                       */
/* ------------------------------------------------------------------ */

export interface DecayTier {
  maxAgeDays: number;
  syncIntervalMs: number;
  label: string;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DECAY_SCHEDULE: DecayTier[] = [
  { maxAgeDays: 1, syncIntervalMs: 1 * HOUR, label: "Fresh (< 24h)" },
  { maxAgeDays: 7, syncIntervalMs: 6 * HOUR, label: "Recent (1–7d)" },
  { maxAgeDays: 28, syncIntervalMs: 1 * DAY, label: "Active (8–28d)" },
  { maxAgeDays: 90, syncIntervalMs: 3 * DAY, label: "Mature (29–90d)" },
  { maxAgeDays: 180, syncIntervalMs: 7 * DAY, label: "Aging (91–180d)" },
  { maxAgeDays: Infinity, syncIntervalMs: 30 * DAY, label: "Archived (180d+)" },
];

/* ------------------------------------------------------------------ */
/*  Tier helpers                                                       */
/* ------------------------------------------------------------------ */

export function getDecayTier(publishedDate: string): DecayTier {
  const now = new Date();
  const pub = new Date(publishedDate + "T00:00:00Z");
  const ageDays = (now.getTime() - pub.getTime()) / DAY;

  for (const tier of DECAY_SCHEDULE) {
    if (ageDays < tier.maxAgeDays) return tier;
  }
  return DECAY_SCHEDULE[DECAY_SCHEDULE.length - 1];
}

export function needsPerformanceSync(item: {
  publishedDate: string | null;
  lastPerformanceSyncAt: Date | null;
}): { needsSync: boolean; tier: DecayTier; reason: string } {
  if (!item.publishedDate) {
    return {
      needsSync: false,
      tier: DECAY_SCHEDULE[DECAY_SCHEDULE.length - 1],
      reason: "No published date",
    };
  }

  const tier = getDecayTier(item.publishedDate);

  if (!item.lastPerformanceSyncAt) {
    return { needsSync: true, tier, reason: "Never synced" };
  }

  const elapsed = Date.now() - item.lastPerformanceSyncAt.getTime();
  if (elapsed >= tier.syncIntervalMs) {
    return { needsSync: true, tier, reason: `${tier.label}: overdue` };
  }

  return { needsSync: false, tier, reason: `${tier.label}: up to date` };
}

/* ------------------------------------------------------------------ */
/*  Platform kind detection                                            */
/* ------------------------------------------------------------------ */

export type PlatformKind =
  | "youtube"
  | "youtube_community"
  | "instagram"
  | "twitter"
  | "threads"
  | "linkedin"
  | "tiktok";

/**
 * Map an item's `platform[]` strings to the set of SC-supported platform
 * kinds. Order matters for YouTube Community vs. YouTube — check community
 * first so the regular-YouTube test doesn't swallow it.
 */
export function platformKindsFor(platforms: string[] | null): Set<PlatformKind> {
  const out = new Set<PlatformKind>();
  for (const p of platforms || []) {
    if (p === "YouTube Community") out.add("youtube_community");
    else if (p.includes("YouTube")) out.add("youtube");
    else if (p.includes("Instagram")) out.add("instagram");
    else if (
      p === "X" ||
      p === "X (Starter Story)" ||
      p === "X (Pat Walls)" ||
      p === "Twitter" ||
      p === "Twitter (Pat Walls)"
    )
      out.add("twitter");
    else if (p === "Threads") out.add("threads");
    else if (p === "LinkedIn") out.add("linkedin");
    else if (p === "TikTok") out.add("tiktok");
  }
  return out;
}

/**
 * Resolve the SC platform kind from a canonical `post_type`. Preferred over
 * `platformKindsFor` — a post type is 1:1 with an SC endpoint, so callers
 * that have the post type should use this and avoid the fuzzy string match.
 * Returns null for post types with no SC coverage (newsletter).
 */
export function platformKindFromPostType(
  postType: string | null | undefined
): PlatformKind | null {
  switch (postType) {
    case "youtube_long":
    case "youtube_shorts":
      return "youtube";
    case "youtube_community":
      return "youtube_community";
    case "instagram_reel":
    case "instagram_post":
    case "instagram_story":
      return "instagram";
    case "x":
      return "twitter";
    case "threads":
      return "threads";
    case "linkedin":
      return "linkedin";
    case "tiktok":
      return "tiktok";
    default:
      return null;
  }
}

/**
 * Single source of truth for "what SC endpoints does this item belong to?".
 * Prefers `post_type` (canonical 1:1 with an endpoint) and falls back to the
 * legacy `platform[]` string matcher for rows written before post_type rolled
 * out. Every sweep filter AND executor should use this — keeping the filter
 * and executor in sync is what prevents silent-skip bugs.
 */
export function resolveItemPlatformKinds(input: {
  postType: string | null | undefined;
  platform: string[] | null;
}): Set<PlatformKind> {
  const out = new Set<PlatformKind>();
  const fromPostType = platformKindFromPostType(input.postType);
  if (fromPostType) {
    out.add(fromPostType);
    return out;
  }
  for (const k of platformKindsFor(input.platform)) out.add(k);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Per-item refresh                                                   */
/* ------------------------------------------------------------------ */

/**
 * Stamp a sync attempt on an item without touching metrics. Called on every
 * failure path so broken-URL items don't stay pinned to the front of the
 * NULLS-FIRST queue and burn credits every run. The decay interval provides
 * natural retry; the Sync Errors UI gives the user a manual retry.
 */
async function stampSyncResult(itemId: string, error: string | null): Promise<void> {
  await db
    .update(productionItems)
    .set({
      lastPerformanceSyncAt: new Date(),
      lastPerformanceSyncError: error,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, itemId));
}

export interface RefreshItemResult {
  itemId: string;
  updated: boolean;
  platform: PlatformKind | "unknown";
  views: number | null;
  likes: number | null;
  comments: number | null;
  note?: string;
  creditsUsed: number;
}

/**
 * Refresh a single production item's metrics by hitting the matching SC
 * URL endpoint. 1 credit per supported call (0 if the item's platform has
 * no SC coverage or no URL is set). Writes `lastPerformanceSyncAt` on
 * success so the decay gate sees it as fresh.
 *
 * Partial metric updates: platforms that don't return a field (LinkedIn
 * views, YouTube Community views/comments) leave the existing column
 * untouched rather than clobbering it with 0 or NULL.
 */
export async function refreshItemMetrics(itemId: string): Promise<RefreshItemResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      platform: productionItems.platform,
      postType: productionItems.postType,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) {
    throw new Error(`Item not found: ${itemId}`);
  }

  const url = item.publishedLink || item.youtubeUrl || "";
  const platforms = (item.platform as string[] | null) ?? [];
  const kinds = resolveItemPlatformKinds({
    postType: item.postType,
    platform: item.platform as string[] | null,
  });

  // Apply the likes-multiplier estimator on platforms where SC doesn't return
  // view counts (LinkedIn, YouTube Community, Instagram Photo, Threads
  // fallback). Returns the final view count + estimated flag to persist.
  const deriveViews = (
    realViews: number | null,
    likes: number | null
  ): { views: number | null; estimated: boolean } => {
    if (realViews != null) return { views: realViews, estimated: false };
    if (likes == null) return { views: null, estimated: false };
    const est = estimateViewsFromLikes(platforms, likes);
    return est.estimated
      ? { views: est.views, estimated: true }
      : { views: null, estimated: false };
  };

  // --- YouTube video / shorts (SC returns real views + likes + comments) ---
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
        viewsEstimated: false,
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return { itemId, updated: true, platform: "youtube", views, likes, comments, creditsUsed: 1 };
  }

  // --- YouTube Community post (SC returns only likeCount → estimate views) ---
  if (kinds.has("youtube_community") && url) {
    const post = await fetchYouTubeCommunityPostByUrl(url);
    if (!post) {
      const note = "Community post not found at URL";
      await stampSyncResult(itemId, note);
      return {
        itemId,
        updated: false,
        platform: "youtube_community",
        views: null,
        likes: null,
        comments: null,
        note,
        creditsUsed: 1,
      };
    }
    const derived = deriveViews(null, post.likes);
    await db
      .update(productionItems)
      .set({
        ...(post.likes != null && { likes: post.likes }),
        ...(derived.views != null && {
          views: derived.views,
          viewsEstimated: derived.estimated,
        }),
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "youtube_community",
      views: derived.views,
      likes: post.likes,
      comments: null,
      creditsUsed: 1,
    };
  }

  // --- Twitter / X (SC returns real views) ---
  if (kinds.has("twitter") && url) {
    const tweet = await fetchTweetByUrl(url);
    if (!tweet || !tweet.legacy) {
      const note = tweet ? "Tweet response missing engagement fields" : "Tweet not found at URL";
      await stampSyncResult(itemId, note);
      return {
        itemId,
        updated: false,
        platform: "twitter",
        views: null,
        likes: null,
        comments: null,
        note,
        creditsUsed: 1,
      };
    }
    const views = tweet.views?.count ? parseInt(tweet.views.count, 10) : null;
    const likes = tweet.legacy.favorite_count ?? null;
    const comments = tweet.legacy.reply_count ?? null;
    await db
      .update(productionItems)
      .set({
        ...(views != null && { views, viewsEstimated: false }),
        ...(likes != null && { likes }),
        ...(comments != null && { comments }),
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return { itemId, updated: true, platform: "twitter", views, likes, comments, creditsUsed: 1 };
  }

  // --- Instagram post / reel (Reels: SC returns play_count; Photos: null → estimate) ---
  if (kinds.has("instagram") && url) {
    const post = await fetchInstagramPostByUrl(url);
    if (!post) {
      const note = "Post not found at URL";
      await stampSyncResult(itemId, note);
      return {
        itemId,
        updated: false,
        platform: "instagram",
        views: null,
        likes: null,
        comments: null,
        note,
        creditsUsed: 1,
      };
    }
    const { likes, comments, thumbnail } = post;
    const derived = deriveViews(post.views, likes);
    await db
      .update(productionItems)
      .set({
        ...(derived.views != null && {
          views: derived.views,
          viewsEstimated: derived.estimated,
        }),
        ...(likes != null && { likes }),
        ...(comments != null && { comments }),
        ...(thumbnail && { thumbnail }),
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "instagram",
      views: derived.views,
      likes,
      comments,
      creditsUsed: 1,
    };
  }

  // --- Threads (SC usually returns view_counts; fall back to estimator) ---
  if (kinds.has("threads") && url) {
    const post = await fetchThreadsPostByUrl(url);
    if (!post) {
      const note = "Threads post not found at URL";
      await stampSyncResult(itemId, note);
      return {
        itemId,
        updated: false,
        platform: "threads",
        views: null,
        likes: null,
        comments: null,
        note,
        creditsUsed: 1,
      };
    }
    const { likes, comments } = post;
    const derived = deriveViews(post.views, likes);
    await db
      .update(productionItems)
      .set({
        ...(derived.views != null && {
          views: derived.views,
          viewsEstimated: derived.estimated,
        }),
        ...(likes != null && { likes }),
        ...(comments != null && { comments }),
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "threads",
      views: derived.views,
      likes,
      comments,
      creditsUsed: 1,
    };
  }

  // --- LinkedIn (SC returns no views → always estimate from likes) ---
  if (kinds.has("linkedin") && url) {
    const post = await fetchLinkedInPostByUrl(url);
    if (!post) {
      const note = "LinkedIn post not found at URL";
      await stampSyncResult(itemId, note);
      return {
        itemId,
        updated: false,
        platform: "linkedin",
        views: null,
        likes: null,
        comments: null,
        note,
        creditsUsed: 1,
      };
    }
    const { likes, comments } = post;
    const derived = deriveViews(null, likes);
    await db
      .update(productionItems)
      .set({
        ...(derived.views != null && {
          views: derived.views,
          viewsEstimated: derived.estimated,
        }),
        ...(likes != null && { likes }),
        ...(comments != null && { comments }),
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "linkedin",
      views: derived.views,
      likes,
      comments,
      creditsUsed: 1,
    };
  }

  // --- TikTok (SC returns real play_count + digg + comment) ---
  if (kinds.has("tiktok") && url) {
    const post = await fetchTikTokVideoByUrl(url);
    if (!post) {
      const note = "TikTok video not found at URL";
      await stampSyncResult(itemId, note);
      return {
        itemId,
        updated: false,
        platform: "tiktok",
        views: null,
        likes: null,
        comments: null,
        note,
        creditsUsed: 1,
      };
    }
    const { likes, comments } = post;
    const derived = deriveViews(post.views, likes);
    await db
      .update(productionItems)
      .set({
        ...(derived.views != null && {
          views: derived.views,
          viewsEstimated: derived.estimated,
        }),
        ...(likes != null && { likes }),
        ...(comments != null && { comments }),
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return {
      itemId,
      updated: true,
      platform: "tiktok",
      views: derived.views,
      likes,
      comments,
      creditsUsed: 1,
    };
  }

  const note = "Platform not supported or missing URL";
  await stampSyncResult(itemId, note);
  return {
    itemId,
    updated: false,
    platform: "unknown",
    views: null,
    likes: null,
    comments: null,
    note,
    creditsUsed: 0,
  };
}

/* ------------------------------------------------------------------ */
/*  Due-items query — exposed for the cron + the settings dashboard    */
/* ------------------------------------------------------------------ */

interface DueItem {
  id: string;
  kinds: Set<PlatformKind>;
  tier: DecayTier;
  lastPerformanceSyncAt: Date | null;
}

export interface DueSyncSummary {
  items: DueItem[];
  totalDue: number;
  byTier: Record<string, number>;
  byPlatform: Record<string, number>;
}

export async function getItemsDueForSync(): Promise<DueSyncSummary> {
  // NULLS FIRST on lastPerformanceSyncAt so "Never" rows backfill first,
  // then oldest-synced rows, so we don't get starvation where fresh items
  // keep monopolizing the credit cap.
  const rows = await db
    .select({
      id: productionItems.id,
      publishedDate: productionItems.publishedDate,
      lastPerformanceSyncAt: productionItems.lastPerformanceSyncAt,
      platform: productionItems.platform,
      postType: productionItems.postType,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.publishedDate)
      )
    )
    .orderBy(
      sql`${productionItems.lastPerformanceSyncAt} ASC NULLS FIRST`,
      asc(productionItems.publishedDate)
    );

  const items: DueItem[] = [];
  const byTier: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};

  for (const r of rows) {
    const check = needsPerformanceSync({
      publishedDate: r.publishedDate,
      lastPerformanceSyncAt: r.lastPerformanceSyncAt,
    });
    if (!check.needsSync) continue;
    const kinds = resolveItemPlatformKinds({
      postType: r.postType,
      platform: r.platform as string[] | null,
    });
    if (kinds.size === 0) continue;

    items.push({
      id: r.id,
      kinds,
      tier: check.tier,
      lastPerformanceSyncAt: r.lastPerformanceSyncAt,
    });
    byTier[check.tier.label] = (byTier[check.tier.label] || 0) + 1;
    for (const kind of kinds) {
      byPlatform[kind] = (byPlatform[kind] || 0) + 1;
    }
  }

  return {
    items,
    totalDue: items.length,
    byTier,
    byPlatform,
  };
}

/* ------------------------------------------------------------------ */
/*  Main orchestrator — one tick, all platforms                        */
/* ------------------------------------------------------------------ */

export interface PerformanceSyncResult {
  creditsUsed: number;
  itemsUpdated: number;
  itemsAttempted: number;
  byTier: Record<string, number>;
  byPlatform: Record<string, { attempted: number; updated: number; errors: number }>;
  errors: string[];
  skippedReason?: string;
}

export async function syncPerformanceData(): Promise<PerformanceSyncResult> {
  const startedAt = new Date();
  const due = await getItemsDueForSync();

  const byPlatform: PerformanceSyncResult["byPlatform"] = {};
  const errors: string[] = [];

  if (due.totalDue === 0) {
    await db.insert(syncLogs).values({
      syncType: "performance-decay",
      status: "success",
      itemsFetched: 0,
      itemsUpdated: 0,
      startedAt,
      completedAt: new Date(),
    });
    return {
      creditsUsed: 0,
      itemsUpdated: 0,
      itemsAttempted: 0,
      byTier: due.byTier,
      byPlatform,
      errors,
      skippedReason: "No items due for sync",
    };
  }

  let creditsUsed = 0;
  let itemsUpdated = 0;
  let itemsAttempted = 0;

  for (const item of due.items) {
    itemsAttempted++;
    // Pick a single platform attribution for the stats bucket. refreshItemMetrics
    // handles one endpoint per call via the if-chain; the first kind that matches
    // the router order there is what wins.
    const kind =
      [...item.kinds].find((k) =>
        ["youtube", "youtube_community", "twitter", "instagram", "threads", "linkedin"].includes(k)
      ) ?? "unknown";
    byPlatform[kind] ??= { attempted: 0, updated: 0, errors: 0 };
    byPlatform[kind].attempted++;

    try {
      const r = await refreshItemMetrics(item.id);
      creditsUsed += r.creditsUsed;
      if (r.updated) {
        itemsUpdated++;
        byPlatform[r.platform] ??= { attempted: 0, updated: 0, errors: 0 };
        byPlatform[r.platform].updated++;
      } else if (r.note) {
        errors.push(`${item.id} (${r.platform}): ${r.note}`);
        byPlatform[kind].errors++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${item.id} (${kind}): ${msg}`);
      byPlatform[kind].errors++;
      await stampSyncResult(item.id, msg);
      creditsUsed++;
    }
  }

  await db.insert(syncLogs).values({
    syncType: "performance-decay",
    status: itemsUpdated === 0 && errors.length > 0 ? "error" : "success",
    itemsFetched: itemsAttempted,
    itemsUpdated,
    errorMessage: errors.length > 0 ? errors.slice(0, 5).join("; ") : null,
    startedAt,
    completedAt: new Date(),
  });

  return {
    creditsUsed,
    itemsUpdated,
    itemsAttempted,
    byTier: due.byTier,
    byPlatform,
    errors,
  };
}
