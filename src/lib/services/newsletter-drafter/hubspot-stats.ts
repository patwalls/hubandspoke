// A sent Starter Story HubSpot issue's numbers on its content item, the same
// column reuse as every other channel: unique opens → `views` ("reads"),
// unique clicks → `clicks`, delivered → `newsletter_recipients` (the open-rate
// denominator). The item's `platform_content_id` is the HubSpot email id (set
// by the push or the history import). Read-only GET per issue; refreshed
// daily by newsletter-history-sync for recent issues and on the content
// page's "Sync metrics". See docs/automation.md → newsletter-history-sync.

import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getHubspotEmailStats, type HubspotEmailStats } from "@/lib/hubspot-marketing-email";

export type FetchHubspotStats = (emailId: string) => Promise<HubspotEmailStats | null>;

/** A published Starter Story newsletter whose id is a HubSpot email id (not Klaviyo's). Pure. */
export function hubspotEmailIdOf(item: { brand: string | null; postType: string | null; platformContentId: string | null }): string | null {
  if (item.brand !== "starter-story" || item.postType !== "newsletter") return null;
  return item.platformContentId && /^\d+$/.test(item.platformContentId) ? item.platformContentId : null;
}

/** Fetch one issue's stats and write them on its item. Null when HubSpot has none yet (unsent). */
export async function syncHubspotNewsletterStats(
  itemId: string,
  emailId: string,
  fetchStats: FetchHubspotStats = getHubspotEmailStats,
): Promise<HubspotEmailStats | null> {
  const stats = await fetchStats(emailId);
  const now = new Date();
  await db
    .update(productionItems)
    .set({
      ...(stats ? { views: stats.opens, viewsEstimated: false, clicks: stats.clicks, newsletterRecipients: stats.delivered } : {}),
      lastPerformanceSyncAt: now,
      lastPerformanceSyncError: stats ? null : "HubSpot has no stats for this email yet",
      updatedAt: now,
    })
    .where(eq(productionItems.id, itemId));
  return stats;
}

/** Every HubSpot issue published since `since`: refresh its stats. One failure doesn't stop the rest. */
export async function syncRecentHubspotNewsletterStats(since: Date, fetchStats: FetchHubspotStats = getHubspotEmailStats): Promise<number> {
  const rows = await db
    .select({ id: productionItems.id, brand: productionItems.brand, postType: productionItems.postType, platformContentId: productionItems.platformContentId })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, "starter-story"),
        eq(productionItems.postType, "newsletter"),
        eq(productionItems.status, "Published"),
        gte(productionItems.publishedAt, since),
        isNull(productionItems.deletedAt),
      ),
    );
  let n = 0;
  for (const row of rows) {
    const emailId = hubspotEmailIdOf(row);
    if (!emailId) continue;
    if (await syncHubspotNewsletterStats(row.id, emailId, fetchStats).catch(() => null)) n++;
  }
  return n;
}
