/**
 * Attaching a ManyChat DM keyword to an Instagram post — the go→go chain
 * the "Attach DM keyword" dialog builds, as a service so the design editor
 * can do it automatically on a post's first draft.
 *
 *   go/<keyword>  →  go/<per-post slug>  →  <destination>
 *
 * Keywords are a FIXED pool (short links tagged "dm", each hard-wired to a
 * ManyChat automation); a post borrows one by pointing it at its own
 * tracked link. `productionItems.short_link_slug` is the pointer.
 */
import { randomUUID } from "node:crypto";
import { eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createShortLink, findShortLinksByContent, getShortLink, listShortLinks, updateShortLink, ShortLinksApiError, type ShortLink } from "@/lib/services/short-links";
import { suggestCtaDestination } from "@/lib/services/draft-algorithm/tracked-cta";

export const DM_TAG = "dm";
const BASE_URL = process.env.SHORT_LINKS_BASE_URL ?? "https://go.starterstory.com";

export interface DmKeywordChain {
  keywordSlug: string;
  perPostSlug: string;
  perPostGoUrl: string;
  destinationUrl: string;
}

/** Wire `keywordSlug` to this post (destination + utm on the per-post link)
 *  and record it on the item. */
export async function attachDmKeyword(args: { itemId: string; keywordSlug: string; destinationUrl: string }): Promise<DmKeywordChain> {
  const keywordSlug = args.keywordSlug.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(keywordSlug)) throw new ShortLinksApiError(400, "Invalid keyword slug");
  if (!/^https:\/\//i.test(args.destinationUrl)) throw new ShortLinksApiError(400, "destinationUrl must be an https:// URL");
  const [item] = await db.select({ id: productionItems.id, utmCampaign: productionItems.utmCampaign }).from(productionItems).where(eq(productionItems.id, args.itemId)).limit(1);
  if (!item) throw new ShortLinksApiError(404, "Item not found");

  const perPostSlug = await ensurePerPostLink({ itemId: args.itemId, utmCampaign: item.utmCampaign ?? null, destinationUrl: args.destinationUrl });
  const perPostGoUrl = `${BASE_URL}/${perPostSlug}`;
  const existingKeyword = await getShortLink(keywordSlug);
  if (existingKeyword) await updateShortLink(keywordSlug, { destinationUrl: perPostGoUrl, tag: DM_TAG, archived: false });
  else await createShortLink({ slug: keywordSlug, destinationUrl: perPostGoUrl, tag: DM_TAG });
  await db.update(productionItems).set({ shortLinkSlug: keywordSlug, updatedAt: new Date() }).where(eq(productionItems.id, args.itemId));
  return { keywordSlug, perPostSlug, perPostGoUrl, destinationUrl: args.destinationUrl };
}

/**
 * The keyword the dialog would put at the top of its list: not archived,
 * not attached to any post, never clicked, least recently clicked — in
 * that order.
 */
export async function pickFreeDmKeyword(): Promise<ShortLink | null> {
  const [links, usage] = await Promise.all([
    listShortLinks({ includeArchived: false, tag: DM_TAG }),
    db
      .select({ slug: productionItems.shortLinkSlug, count: sql<number>`count(*)::int` })
      .from(productionItems)
      .where(isNotNull(productionItems.shortLinkSlug))
      .groupBy(productionItems.shortLinkSlug),
  ]);
  const inUse = new Map(usage.map((u) => [u.slug ?? "", u.count]));
  const sorted = [...links].sort((a, b) => {
    const aUse = (inUse.get(a.slug) ?? 0) > 0;
    const bUse = (inUse.get(b.slug) ?? 0) > 0;
    if (aUse !== bUse) return aUse ? 1 : -1;
    if (a.lastClickedAt === b.lastClickedAt) return a.slug.localeCompare(b.slug);
    if (a.lastClickedAt == null) return -1;
    if (b.lastClickedAt == null) return 1;
    return a.lastClickedAt.localeCompare(b.lastClickedAt);
  });
  return sorted[0] ?? null;
}

/**
 * Give a post a keyword without anyone opening a dialog: the post's current
 * keyword if it has one, else the best free one pointed at the app's
 * suggested CTA destination for the post. Returns null (and does nothing)
 * when the pool is empty or no destination can be suggested.
 */
export async function ensureDmKeyword(itemId: string): Promise<string | null> {
  const [item] = await db.select({ slug: productionItems.shortLinkSlug }).from(productionItems).where(eq(productionItems.id, itemId)).limit(1);
  if (!item) return null;
  if (item.slug) return item.slug;
  const [keyword, destination] = await Promise.all([pickFreeDmKeyword(), suggestCtaDestination({ productionItemId: itemId, channel: "instagram" })]);
  if (!keyword || !destination) return null;
  await attachDmKeyword({ itemId, keywordSlug: keyword.slug, destinationUrl: destination });
  return keyword.slug;
}

// Find-or-create the per-post tracked link (content_external_id = itemId),
// updating its destination. Returns the slug.
async function ensurePerPostLink(args: { itemId: string; utmCampaign: string | null; destinationUrl: string }): Promise<string> {
  const existing = (await findShortLinksByContent(args.itemId)).filter((l) => l.tag !== DM_TAG);
  const reuse = existing.find((l) => !l.archived) ?? existing[0];
  if (reuse) {
    await updateShortLink(reuse.slug, { destinationUrl: args.destinationUrl, archived: false, contentSource: "hubandspoke", contentExternalId: args.itemId, channel: "instagram", utmCampaign: args.utmCampaign });
    return reuse.slug;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = `cta-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    try {
      await createShortLink({ slug, destinationUrl: args.destinationUrl, tag: "ig-cta", contentSource: "hubandspoke", contentExternalId: args.itemId, channel: "instagram", utmCampaign: args.utmCampaign });
      return slug;
    } catch (err) {
      if (err instanceof ShortLinksApiError && err.status === 409) continue;
      throw err;
    }
  }
  throw new Error("dm-keyword: could not mint a unique per-post slug");
}
