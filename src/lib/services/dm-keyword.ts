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
 *
 * MATG / MFM (`usesRebrandlyDm`) run the same chain on Rebrandly
 * (clickhubspot.com) instead — see the Rebrandly section at the bottom.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createShortLink, findShortLinksByContent, getShortLink, listShortLinks, updateShortLink, ShortLinksApiError, type ShortLink } from "@/lib/services/short-links";
import { suggestCtaDestination } from "@/lib/services/draft-algorithm/tracked-cta";
import { usesCtaOffer } from "@/lib/services/cta-offer";
import { REBRANDLY_DM_BASE_URL, brandShortName, isBrandDmSlashtag, perPostDmSlashtag, usesRebrandlyDm } from "@/lib/cta-offer-brands";
import { createLink, getLinkBySlashtag, listWorkspaceLinks, updateLinkDestination, type RebrandlyLink } from "@/lib/services/rebrandly";

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
  const [item] = await db.select({ id: productionItems.id, utmCampaign: productionItems.utmCampaign, brand: productionItems.brand }).from(productionItems).where(eq(productionItems.id, args.itemId)).limit(1);
  if (!item) throw new ShortLinksApiError(404, "Item not found");
  if (usesRebrandlyDm(item.brand)) return attachRebrandlyDmKeyword({ itemId: item.id, brand: item.brand, keywordSlug, destinationUrl: args.destinationUrl });

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
  const [item] = await db.select({ slug: productionItems.shortLinkSlug, brand: productionItems.brand }).from(productionItems).where(eq(productionItems.id, itemId)).limit(1);
  if (!item) return null;
  // MATG / MFM: their own Rebrandly keyword pool. A leftover Starter Story
  // slug on the item doesn't count as attached.
  if (usesRebrandlyDm(item.brand)) {
    if (item.slug && isBrandDmSlashtag(item.brand, item.slug)) return item.slug;
    const [keyword, destination] = await Promise.all([pickFreeRebrandlyKeyword(item.brand), suggestCtaDestination({ productionItemId: itemId, channel: "instagram" })]);
    if (!keyword || !destination) return null;
    await attachRebrandlyDmKeyword({ itemId, brand: item.brand, keywordSlug: keyword.slug, destinationUrl: destination });
    return keyword.slug;
  }
  // Offer-path brands without their own DM setup never borrow a Starter
  // Story keyword (go.starterstory.com + its ManyChat).
  if (usesCtaOffer(item.brand)) return null;
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

// ── Rebrandly brands (MATG, MFM) ───────────────────────────────────────────
// The same go→go chain as Starter Story, on clickhubspot.com:
//
//   <short>-<keyword>  →  <short>-p-<post id>  →  offer + UTMs
//
// The keyword links ("mfm-ideavault", created by hand alongside their
// ManyChat automation) are the brand's pool. Each post gets its own link the
// first time a keyword is attached; when the keyword moves on, only the keyword
// link is repointed, so every post keeps its own destination, UTMs and clicks.

/** Same shape the Attach DM keyword dialog already renders for Starter Story. */
export interface DmKeywordPoolEntry {
  slug: string;
  /** Where commenters end up right now (the current post's offer). */
  destinationUrl: string;
  clicksCount: number;
  lastClickedAt: string | null;
  tag: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  inUseCount: number;
  inUseItems: { id: string; title: string | null }[];
}

export interface DmPostLink {
  slug: string;
  destinationUrl: string;
  clicksCount: number;
}

export async function listDmKeywordPool(brand: string, opts: { itemId?: string } = {}): Promise<{ shortLinks: DmKeywordPoolEntry[]; postLink: DmPostLink | null }> {
  if (!usesRebrandlyDm(brand)) throw new ShortLinksApiError(400, `${brand} doesn't use Rebrandly DM keywords`);
  const all = await listWorkspaceLinks();
  const byUrl = new Map(all.map((l) => [`${REBRANDLY_DM_BASE_URL}/${l.slashtag.toLowerCase()}`, l]));
  const ownSlug = opts.itemId ? perPostDmSlashtag(brand, opts.itemId) : null;
  const own = ownSlug ? all.find((l) => l.slashtag.toLowerCase() === ownSlug) : undefined;
  const postLink = own ? { slug: ownSlug!, destinationUrl: own.destination, clicksCount: own.clicks } : null;

  const keywords = all.filter((l) => isBrandDmSlashtag(brand, l.slashtag));
  if (keywords.length === 0) return { shortLinks: [], postLink };
  const slugs = keywords.map((l) => l.slashtag.toLowerCase());
  const attached = await db
    .select({ slug: productionItems.shortLinkSlug, id: productionItems.id, title: productionItems.title })
    .from(productionItems)
    .where(and(eq(productionItems.brand, brand), inArray(productionItems.shortLinkSlug, slugs)))
    .orderBy(desc(productionItems.updatedAt));
  const bySlug = new Map<string, { id: string; title: string | null }[]>();
  for (const a of attached) {
    const list = bySlug.get(a.slug ?? "") ?? [];
    list.push({ id: a.id, title: a.title });
    bySlug.set(a.slug ?? "", list);
  }
  const now = new Date().toISOString();
  const shortLinks = keywords.map((l) => {
    const slug = l.slashtag.toLowerCase();
    const items = bySlug.get(slug) ?? [];
    // Show where commenters actually land: follow the keyword through the
    // current post's own link.
    const hop = byUrl.get(l.destination.replace(/\/$/, "").toLowerCase());
    return {
      slug,
      destinationUrl: hop ? hop.destination : l.destination,
      clicksCount: l.clicks,
      lastClickedAt: l.lastClickAt,
      tag: DM_TAG,
      archived: false,
      createdAt: l.createdAt ?? now,
      updatedAt: l.updatedAt ?? now,
      inUseCount: items.length,
      inUseItems: items,
    };
  });
  return { shortLinks, postLink };
}

/** The brand's best free keyword — same order as pickFreeDmKeyword. */
export async function pickFreeRebrandlyKeyword(brand: string): Promise<DmKeywordPoolEntry | null> {
  const { shortLinks: pool } = await listDmKeywordPool(brand);
  const sorted = [...pool].sort((a, b) => {
    const aUse = a.inUseCount > 0;
    const bUse = b.inUseCount > 0;
    if (aUse !== bUse) return aUse ? 1 : -1;
    if (a.lastClickedAt === b.lastClickedAt) return a.slug.localeCompare(b.slug);
    if (a.lastClickedAt == null) return -1;
    if (b.lastClickedAt == null) return 1;
    return a.lastClickedAt.localeCompare(b.lastClickedAt);
  });
  return sorted[0] ?? null;
}

// Find-or-create this post's own link, pointed at `destination`.
async function ensurePerPostRebrandlyLink(args: { itemId: string; brand: string; destinationUrl: string }): Promise<RebrandlyLink> {
  const slashtag = perPostDmSlashtag(args.brand, args.itemId);
  const existing = await getLinkBySlashtag(slashtag);
  if (existing) {
    return existing.destination === args.destinationUrl ? existing : updateLinkDestination(existing, args.destinationUrl);
  }
  return createLink({ slashtag, destination: args.destinationUrl, title: `Hub & Spoke post ${args.itemId}` });
}

async function attachRebrandlyDmKeyword(args: { itemId: string; brand: string; keywordSlug: string; destinationUrl: string }): Promise<DmKeywordChain> {
  if (!isBrandDmSlashtag(args.brand, args.keywordSlug)) {
    throw new ShortLinksApiError(400, `"${args.keywordSlug}" isn't one of this brand's keywords (they start with "${brandShortName(args.brand)}-")`);
  }
  const keyword = await getLinkBySlashtag(args.keywordSlug);
  if (!keyword) throw new ShortLinksApiError(404, `No clickhubspot.com/${args.keywordSlug} link in Rebrandly — create it there first`);
  const postLink = await ensurePerPostRebrandlyLink({ itemId: args.itemId, brand: args.brand, destinationUrl: args.destinationUrl });
  const perPostUrl = `${REBRANDLY_DM_BASE_URL}/${postLink.slashtag.toLowerCase()}`;
  if (keyword.destination !== perPostUrl) await updateLinkDestination(keyword, perPostUrl);
  await db.update(productionItems).set({ shortLinkSlug: args.keywordSlug, updatedAt: new Date() }).where(eq(productionItems.id, args.itemId));
  return { keywordSlug: args.keywordSlug, perPostSlug: postLink.slashtag.toLowerCase(), perPostGoUrl: perPostUrl, destinationUrl: args.destinationUrl };
}
