/**
 * Performance Data Decay Service.
 *
 * Syncs Scrape Creators metrics (views / likes / comments) into production_items
 * on a decay schedule — fresh content refreshes often, old content rarely — so
 * we don't burn API credits on archival items.
 *
 * Decay tiers (based on content age since publishedDate):
 *   Fresh    (< 24h)   → sync every 1 hour    (catches early engagement curve)
 *   Recent   (1–7d)    → sync every 6 hours
 *   Active   (8–28d)   → sync daily
 *   Mature   (29–90d)  → sync every 3 days
 *   Aging    (91–180d) → sync weekly
 *   Archived (180d+)   → sync monthly
 *
 * Brand-agnostic: both MATG and Starter Story are covered in one pass via the
 * BRAND_YT_HANDLES table. Non-YouTube platforms are skipped for now (SC has
 * URL-based endpoints for them; wiring TBD).
 */

import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import {
  fetchYouTubeChannelVideos,
  fetchYouTubeChannelShorts,
  fetchSingleVideo,
  type SCVideo,
  type SCShort,
} from "./matg-sync";

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

/** Safety cap — never spend more than this many API credits in one run.
 *  Tune via SC_MAX_CREDITS_PER_RUN env var. At hourly cadence, 60 = 1440/day. */
const MAX_CREDITS_PER_RUN = Number(process.env.SC_MAX_CREDITS_PER_RUN) || 60;

/** YouTube handle → channel-videos / channel-shorts bulk fetch targets.
 *  One fetch per handle = 1 credit. MATG has 1 channel; SS has 2. */
const BRAND_YT_HANDLES: Record<string, string[]> = {
  matg: ["MATGpod"],
  "starter-story": ["starterstory", "StarterStoryBuild"],
};

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

  // Never been synced — always needs it
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
/*  Query items due for sync                                           */
/* ------------------------------------------------------------------ */

interface DueItem {
  id: string;
  brand: string;
  publishedDate: string;
  publishedLink: string | null;
  youtubeUrl: string | null;
  platform: string[] | null;
  tier: DecayTier;
}

export interface DueSyncSummary {
  videos: DueItem[];
  shorts: DueItem[];
  totalDue: number;
  estimatedCredits: number;
  byTier: Record<string, number>;
}

export async function getItemsDueForSync(): Promise<DueSyncSummary> {
  const items = await db
    .select({
      id: productionItems.id,
      brand: productionItems.brand,
      publishedDate: productionItems.publishedDate,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      platform: productionItems.platform,
      lastPerformanceSyncAt: productionItems.lastPerformanceSyncAt,
    })
    .from(productionItems)
    .where(isNotNull(productionItems.publishedDate));

  const videos: DueItem[] = [];
  const shorts: DueItem[] = [];
  const byTier: Record<string, number> = {};

  for (const item of items) {
    const check = needsPerformanceSync({
      publishedDate: item.publishedDate,
      lastPerformanceSyncAt: item.lastPerformanceSyncAt,
    });

    if (!check.needsSync) continue;

    // Only items on YouTube are scrape-able by this service today. Others are
    // skipped — their metrics come from manual edits / Notion / upstream
    // batch jobs until we wire up IG/Twitter/LinkedIn URL-based fetches.
    const platforms = (item.platform as string[]) || [];
    const hasYouTube = platforms.some((p) => p.includes("YouTube"));
    if (!hasYouTube) continue;

    // Skip brands we don't have YouTube handles for.
    if (!BRAND_YT_HANDLES[item.brand]) continue;

    const dueItem: DueItem = {
      id: item.id,
      brand: item.brand,
      publishedDate: item.publishedDate!,
      publishedLink: item.publishedLink,
      youtubeUrl: item.youtubeUrl,
      platform: platforms,
      tier: check.tier,
    };

    byTier[check.tier.label] = (byTier[check.tier.label] || 0) + 1;

    if (platforms.includes("YouTube Shorts")) {
      shorts.push(dueItem);
    } else {
      videos.push(dueItem);
    }
  }

  // Estimate credits: one channel-videos + one channel-shorts fetch per brand
  // that has due items, plus one per fresh/recent video individual fetch.
  const brandsWithVideos = new Set(videos.map((v) => v.brand));
  const brandsWithShorts = new Set(shorts.map((s) => s.brand));
  let estimatedCredits = 0;
  for (const brand of brandsWithVideos) {
    estimatedCredits += (BRAND_YT_HANDLES[brand] || []).length;
  }
  for (const brand of brandsWithShorts) {
    estimatedCredits += (BRAND_YT_HANDLES[brand] || []).length;
  }
  const freshRecent = videos.filter((v) => v.tier.maxAgeDays <= 7).length;
  estimatedCredits += freshRecent;

  return {
    videos,
    shorts,
    totalDue: videos.length + shorts.length,
    estimatedCredits: Math.min(estimatedCredits, MAX_CREDITS_PER_RUN),
    byTier,
  };
}

/* ------------------------------------------------------------------ */
/*  Main orchestrator: sync performance data using decay schedule       */
/* ------------------------------------------------------------------ */

export interface PerformanceSyncResult {
  creditsUsed: number;
  itemsUpdated: number;
  shortsUpdated: number;
  videosUpdated: number;
  individualFetches: number;
  byTier: Record<string, number>;
  skippedReason?: string;
}

export async function syncPerformanceData(): Promise<PerformanceSyncResult> {
  const startedAt = new Date();
  const due = await getItemsDueForSync();

  if (due.totalDue === 0) {
    // Log the "nothing to do" sync
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
      shortsUpdated: 0,
      videosUpdated: 0,
      individualFetches: 0,
      byTier: due.byTier,
      skippedReason: "No items due for sync",
    };
  }

  let creditsUsed = 0;
  let shortsUpdated = 0;
  let videosUpdated = 0;
  let individualFetches = 0;

  // Bucket due items by brand so we can issue the right channel-level fetch(es).
  const shortsByBrand = new Map<string, DueItem[]>();
  const videosByBrand = new Map<string, DueItem[]>();
  for (const s of due.shorts) {
    const arr = shortsByBrand.get(s.brand) || [];
    arr.push(s);
    shortsByBrand.set(s.brand, arr);
  }
  for (const v of due.videos) {
    const arr = videosByBrand.get(v.brand) || [];
    arr.push(v);
    videosByBrand.set(v.brand, arr);
  }

  /* ------ Shorts: per-brand channel fetch (1 credit per handle) ------ */
  for (const [brand, dueShorts] of shortsByBrand) {
    const handles = BRAND_YT_HANDLES[brand] || [];
    const shortsByUrl = new Map<string, SCShort>();
    for (const handle of handles) {
      if (creditsUsed >= MAX_CREDITS_PER_RUN) break;
      try {
        const shorts = await fetchYouTubeChannelShorts(handle);
        creditsUsed++;
        for (const s of shorts) shortsByUrl.set(s.url, s);
      } catch (err) {
        console.error(`Performance sync: shorts fetch failed for ${handle}:`, err);
      }
    }

    for (const dueShort of dueShorts) {
      const apiData = shortsByUrl.get(dueShort.publishedLink || "");
      if (!apiData) continue;

      await db
        .update(productionItems)
        .set({
          views: apiData.viewCountInt || 0,
          likes: apiData.likeCountInt || null,
          comments: apiData.commentCountInt || null,
          lastPerformanceSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, dueShort.id));

      shortsUpdated++;
    }
  }

  /* ------ Videos: per-brand channel fetch (1 credit per handle, views only) ------ */
  for (const [brand, dueVideos] of videosByBrand) {
    if (creditsUsed >= MAX_CREDITS_PER_RUN) break;
    const handles = BRAND_YT_HANDLES[brand] || [];
    const videosByUrl = new Map<string, SCVideo>();
    for (const handle of handles) {
      if (creditsUsed >= MAX_CREDITS_PER_RUN) break;
      try {
        const videos = await fetchYouTubeChannelVideos(handle);
        creditsUsed++;
        for (const v of videos) videosByUrl.set(v.url, v);
      } catch (err) {
        console.error(`Performance sync: videos fetch failed for ${handle}:`, err);
      }
    }

    for (const dueVideo of dueVideos) {
      const apiData = videosByUrl.get(dueVideo.publishedLink || "");
      if (!apiData) continue;

      await db
        .update(productionItems)
        .set({
          views: apiData.viewCountInt || 0,
          lastPerformanceSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, dueVideo.id));

      videosUpdated++;
    }
  }

  /* ------ Fresh/Recent videos: individual fetch for likes/comments ------ */
  const freshRecentVideos = due.videos.filter(
    (v) => v.tier.maxAgeDays <= 7 && (v.youtubeUrl || v.publishedLink)
  );

  for (const video of freshRecentVideos) {
    if (creditsUsed >= MAX_CREDITS_PER_RUN) break;

    const targetUrl = video.youtubeUrl || video.publishedLink!;
    try {
      const detail = await fetchSingleVideo(targetUrl);
      creditsUsed++;
      individualFetches++;

      await db
        .update(productionItems)
        .set({
          views: detail.viewCountInt || 0,
          likes: detail.likeCountInt || null,
          comments: detail.commentCountInt || null,
          lastPerformanceSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, video.id));
    } catch (err) {
      console.error(
        `Performance sync: individual fetch failed for ${targetUrl}:`,
        err
      );
    }
  }

  const totalUpdated = shortsUpdated + videosUpdated;

  // Log sync
  await db.insert(syncLogs).values({
    syncType: "performance-decay",
    status: "success",
    itemsFetched: due.totalDue,
    itemsUpdated: totalUpdated,
    startedAt,
    completedAt: new Date(),
  });

  return {
    creditsUsed,
    itemsUpdated: totalUpdated,
    shortsUpdated,
    videosUpdated,
    individualFetches,
    byTier: due.byTier,
  };
}
