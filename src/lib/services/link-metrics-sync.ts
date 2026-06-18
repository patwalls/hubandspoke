import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { listShortLinks, findShortLinksByContent } from "./short-links";

// Pulls clicks + leads from the go.starterstory.com short-link API and writes
// them onto the matching production items. This makes the go links the SOURCE OF
// TRUTH for the CLICKS and LEADS columns/cards (previously sourced from the
// hourly Notion sync, which no longer touches them).
//
// One call to the short-link index returns every hubandspoke-minted link
// (active + archived, so the legacy backfill links are included); we map by
// content_external_id (= productionItems.id) and update only the rows whose
// values actually changed. Mirrors the batch/log shape of performance-decay's
// metric sync.
export async function syncLinkMetrics(): Promise<{
  links: number;
  items: number;
  updated: number;
}> {
  const all = await listShortLinks({ includeArchived: true });
  const hubandspokeLinks = all.filter(
    (l) => l.contentSource === "hubandspoke" && l.contentExternalId,
  );

  // Aggregate per production item. Normally one link per post, but a post can
  // have both a per-post link and (post-backfill it won't, but be safe) a
  // legacy link — sum clicks, and take the MAX leads (leads are computed from
  // the same utm_campaign, so summing would double-count).
  const byItem = new Map<
    string,
    { clicks: number; leads: number; hubspotLeads: number }
  >();
  for (const link of hubandspokeLinks) {
    const id = link.contentExternalId as string;
    const prev = byItem.get(id) ?? { clicks: 0, leads: 0, hubspotLeads: 0 };
    byItem.set(id, {
      clicks: prev.clicks + (link.clicksCount ?? 0),
      leads: Math.max(prev.leads, link.leadsCount ?? 0),
      hubspotLeads: Math.max(prev.hubspotLeads, link.hubspotLeadsCount ?? 0),
    });
  }

  const ids = [...byItem.keys()];
  if (ids.length === 0) {
    return { links: hubandspokeLinks.length, items: 0, updated: 0 };
  }

  const current = await db
    .select({
      id: productionItems.id,
      clicks: productionItems.clicks,
      leads: productionItems.leads,
      hubspotLeads: productionItems.hubspotLeads,
    })
    .from(productionItems)
    .where(inArray(productionItems.id, ids));
  const currentById = new Map(current.map((r) => [r.id, r]));

  let updated = 0;
  for (const [id, metrics] of byItem) {
    const cur = currentById.get(id);
    if (!cur) continue; // link points at an item not in this DB (cross-env) — skip
    if (
      cur.clicks === metrics.clicks &&
      cur.leads === metrics.leads &&
      cur.hubspotLeads === metrics.hubspotLeads
    )
      continue;
    await db
      .update(productionItems)
      .set({
        clicks: metrics.clicks,
        leads: metrics.leads,
        hubspotLeads: metrics.hubspotLeads,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, id));
    updated += 1;
  }

  return { links: hubandspokeLinks.length, items: ids.length, updated };
}

// Sync a single item's clicks/leads on demand (e.g. right after a CTA mint /
// regenerate) so the dashboard reflects the new link without waiting for the
// sweep. Cheap: one filtered index call by content_external_id.
export async function syncLinkMetricsForItem(
  productionItemId: string,
): Promise<void> {
  const links = await findShortLinksByContent(productionItemId);
  if (links.length === 0) return;

  const clicks = links.reduce((sum, l) => sum + (l.clicksCount ?? 0), 0);
  const leads = links.reduce((max, l) => Math.max(max, l.leadsCount ?? 0), 0);
  const hubspotLeads = links.reduce(
    (max, l) => Math.max(max, l.hubspotLeadsCount ?? 0),
    0,
  );
  await db
    .update(productionItems)
    .set({ clicks, leads, hubspotLeads, updatedAt: new Date() })
    .where(eq(productionItems.id, productionItemId));
}
