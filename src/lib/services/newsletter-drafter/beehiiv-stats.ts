// A sent Futurepedia beehiiv issue's numbers on its content item — the same
// column reuse as the HubSpot issues (hubspot-stats.ts): unique opens →
// `views`, unique clicks → `clicks`, delivered → `newsletter_recipients`. The
// item's `platform_content_id` is the beehiiv post id (set by the history
// import or by the send sweep). Read-only GET per issue (stats on ONE post,
// counts only); refreshed daily by newsletter-history-sync for recent issues
// and on the content page's "Sync metrics". See docs/automation.md →
// newsletter-history-sync.

import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getFuturepediaPostStats, type BeehiivPostStats } from "@/lib/beehiiv";

export type FetchBeehiivStats = (postId: string) => Promise<BeehiivPostStats | null>;

/** A Futurepedia newsletter whose id is a beehiiv post id. Pure. */
export function beehiivPostIdOf(item: { brand: string | null; postType: string | null; platformContentId: string | null }): string | null {
  if (item.brand !== "futurepedia" || item.postType !== "newsletter") return null;
  return item.platformContentId && /^post_[0-9a-f-]{36}$/.test(item.platformContentId) ? item.platformContentId : null;
}

/** Fetch one issue's stats and write them on its item. Null when beehiiv has none yet (unsent). */
export async function syncBeehiivNewsletterStats(
  itemId: string,
  postId: string,
  fetchStats: FetchBeehiivStats = getFuturepediaPostStats,
): Promise<BeehiivPostStats | null> {
  const stats = await fetchStats(postId);
  const now = new Date();
  await db
    .update(productionItems)
    .set({
      ...(stats ? { views: stats.opens, viewsEstimated: false, clicks: stats.clicks, newsletterRecipients: stats.delivered } : {}),
      lastPerformanceSyncAt: now,
      lastPerformanceSyncError: stats ? null : "beehiiv has no stats for this post yet",
      updatedAt: now,
    })
    .where(eq(productionItems.id, itemId));
  return stats;
}

/** Every beehiiv issue published since `since`: refresh its stats. One failure doesn't stop the rest. */
export async function syncRecentBeehiivNewsletterStats(since: Date, fetchStats: FetchBeehiivStats = getFuturepediaPostStats): Promise<number> {
  if (fetchStats === getFuturepediaPostStats && !process.env.BEEHIIV_API_KEY) return 0;
  const rows = await db
    .select({ id: productionItems.id, brand: productionItems.brand, postType: productionItems.postType, platformContentId: productionItems.platformContentId })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "futurepedia"),
        eq(productionItems.postType, "newsletter"),
        eq(productionItems.status, "Published"),
        gte(productionItems.publishedAt, since),
        isNull(productionItems.deletedAt),
      ),
    );
  let n = 0;
  for (const row of rows) {
    const postId = beehiivPostIdOf(row);
    if (!postId) continue;
    if (await syncBeehiivNewsletterStats(row.id, postId, fetchStats).catch(() => null)) n++;
  }
  return n;
}
