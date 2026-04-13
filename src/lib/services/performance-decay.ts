/**
 * Performance Data Decay Service for MATG.
 *
 * Implements a decay schedule that syncs fresh content frequently
 * and old content rarely, saving API credits.
 *
 * Decay tiers (based on content age since publishedDate):
 *   Fresh    (< 24h)   → sync every 3 hours
 *   Recent   (1–7d)    → sync every 12 hours
 *   Active   (8–28d)   → sync daily
 *   Mature   (29–90d)  → sync every 3 days
 *   Aging    (91–180d) → sync weekly
 *   Archived (180d+)   → sync monthly
 */

import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import {
  fetchYouTubeVideos,
  fetchYouTubeShorts,
  fetchSingleVideo,
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
  { maxAgeDays: 1, syncIntervalMs: 3 * HOUR, label: "Fresh (< 24h)" },
  { maxAgeDays: 7, syncIntervalMs: 12 * HOUR, label: "Recent (1–7d)" },
  { maxAgeDays: 28, syncIntervalMs: 1 * DAY, label: "Active (8–28d)" },
  { maxAgeDays: 90, syncIntervalMs: 3 * DAY, label: "Mature (29–90d)" },
  { maxAgeDays: 180, syncIntervalMs: 7 * DAY, label: "Aging (91–180d)" },
  { maxAgeDays: Infinity, syncIntervalMs: 30 * DAY, label: "Archived (180d+)" },
];

/** Safety cap — never spend more than this many API credits in one run */
const MAX_CREDITS_PER_RUN = 10;

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
      publishedDate: productionItems.publishedDate,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      platform: productionItems.platform,
      lastPerformanceSyncAt: productionItems.lastPerformanceSyncAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "matg"),
        isNotNull(productionItems.publishedDate)
      )
    );

  const videos: DueItem[] = [];
  const shorts: DueItem[] = [];
  const byTier: Record<string, number> = {};

  for (const item of items) {
    const check = needsPerformanceSync({
      publishedDate: item.publishedDate,
      lastPerformanceSyncAt: item.lastPerformanceSyncAt,
    });

    if (!check.needsSync) continue;

    const dueItem: DueItem = {
      id: item.id,
      publishedDate: item.publishedDate!,
      publishedLink: item.publishedLink,
      youtubeUrl: item.youtubeUrl,
      platform: item.platform as string[] | null,
      tier: check.tier,
    };

    byTier[check.tier.label] = (byTier[check.tier.label] || 0) + 1;

    const platforms = (item.platform as string[]) || [];
    if (platforms.includes("YouTube Shorts")) {
      shorts.push(dueItem);
    } else {
      videos.push(dueItem);
    }
  }

  // Estimate credits: 1 for channel-shorts (if any shorts due), 1 for channel-videos (if any videos due),
  // + 1 per fresh/recent video that needs individual fetch for likes/comments
  let estimatedCredits = 0;
  if (shorts.length > 0) estimatedCredits += 1;
  if (videos.length > 0) {
    estimatedCredits += 1; // channel-videos for bulk view update
    const freshRecent = videos.filter(
      (v) => v.tier.maxAgeDays <= 7
    ).length;
    estimatedCredits += freshRecent; // individual fetches for likes/comments
  }

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
      syncType: "matg-performance",
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

  // Build a set of due item IDs for quick lookup
  const dueShortIds = new Set(due.shorts.map((s) => s.id));
  const dueVideoIds = new Set(due.videos.map((v) => v.id));

  /* ------ Shorts: channel-level fetch (1 credit, full metrics) ------ */
  if (due.shorts.length > 0 && creditsUsed < MAX_CREDITS_PER_RUN) {
    try {
      const allShorts = await fetchYouTubeShorts();
      creditsUsed++;

      // Build a URL → short data map from the API response
      const shortsByUrl = new Map(
        allShorts.map((s) => [s.url, s])
      );

      // Update only the due shorts
      for (const dueShort of due.shorts) {
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
    } catch (err) {
      console.error("Performance sync: shorts fetch failed:", err);
    }
  }

  /* ------ Videos: channel-level fetch (1 credit, views only) ------ */
  if (due.videos.length > 0 && creditsUsed < MAX_CREDITS_PER_RUN) {
    try {
      const allVideos = await fetchYouTubeVideos();
      creditsUsed++;

      const videosByUrl = new Map(
        allVideos.map((v) => [v.url, v])
      );

      // Update views for all due videos from the channel fetch
      for (const dueVideo of due.videos) {
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
    } catch (err) {
      console.error("Performance sync: videos channel fetch failed:", err);
    }
  }

  /* ------ Fresh/Recent videos: individual fetch for likes/comments ------ */
  const freshRecentVideos = due.videos.filter(
    (v) => v.tier.maxAgeDays <= 7 && v.youtubeUrl
  );

  for (const video of freshRecentVideos) {
    if (creditsUsed >= MAX_CREDITS_PER_RUN) break;

    try {
      const detail = await fetchSingleVideo(video.youtubeUrl!);
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
        `Performance sync: individual fetch failed for ${video.youtubeUrl}:`,
        err
      );
    }
  }

  const totalUpdated = shortsUpdated + videosUpdated;

  // Log sync
  await db.insert(syncLogs).values({
    syncType: "matg-performance",
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
