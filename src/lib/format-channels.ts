import { db } from "@/lib/db";
import {
  accounts,
  brands,
  formatChannels,
  productionItems,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PostType } from "@/lib/platform-field-schemas";

// One persisted publishing target on a format: which social account, in what
// post-type shape. post_type is null for the "other" buckets (SS Case Study,
// Paid Ad, etc.) where the production item isn't a canonical social post.
export interface FormatChannelInput {
  accountId: string;
  postType: PostType | null;
}

// Joined shape returned to the UI. The account fields are everything the
// AccountBadge / AccountPostTypePicker need to render without a second query.
export interface FormatChannelWithAccount {
  accountId: string;
  postType: PostType | null;
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    brandSlug: string;
    brandLabel: string;
  };
}

// Read all channels for a set of formats in one round-trip. Returns a Map
// keyed by formatId so callers can attach to each format row without an N+1.
export async function getChannelsForFormats(
  formatIds: string[]
): Promise<Map<string, FormatChannelWithAccount[]>> {
  const out = new Map<string, FormatChannelWithAccount[]>();
  if (formatIds.length === 0) return out;
  const rows = await db
    .select({
      formatId: formatChannels.formatId,
      accountId: formatChannels.accountId,
      postType: formatChannels.postType,
      accountPlatform: accounts.platform,
      accountHandle: accounts.handle,
      accountDisplayName: accounts.displayName,
      accountAvatarUrl: accounts.avatarUrl,
      brandSlug: brands.slug,
      brandLabel: brands.label,
    })
    .from(formatChannels)
    .innerJoin(accounts, eq(accounts.id, formatChannels.accountId))
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(inArray(formatChannels.formatId, formatIds));
  for (const r of rows) {
    const arr = out.get(r.formatId) ?? [];
    arr.push({
      accountId: r.accountId,
      postType: (r.postType as PostType | null) ?? null,
      account: {
        id: r.accountId,
        platform: r.accountPlatform,
        handle: r.accountHandle,
        displayName: r.accountDisplayName,
        avatarUrl: r.accountAvatarUrl ?? null,
        brandSlug: r.brandSlug,
        brandLabel: r.brandLabel,
      },
    });
    out.set(r.formatId, arr);
  }
  return out;
}

/**
 * Pick the best-fit account for repurposing into a given format, based
 * on the brand's published history. Rationale: a format like "Daily
 * Seinfeld" may have multiple `format_channels` rows (e.g., one for the
 * X account, one for the newsletter); when a user repurposes a pillar
 * into that format the route has been picking the first row arbitrarily,
 * landing the derivative on the wrong account. Real production_items
 * carry the actual history — which account has actually published the
 * most of this format, with the highest views.
 *
 * Returns null when nothing in the format has been published yet, so
 * the caller can fall back to the format_channels first-row behavior.
 */
export async function pickBestAccountForFormat(args: {
  brand: string;
  format: string;
  postType?: PostType | null;
}): Promise<{ accountId: string; totalViews: number; itemCount: number } | null> {
  const conditions = [
    eq(productionItems.brand, args.brand),
    sql`lower(${productionItems.format}) = lower(${args.format})`,
    eq(productionItems.status, "Published"),
    isNotNull(productionItems.accountId),
  ];
  if (args.postType) {
    conditions.push(eq(productionItems.postType, args.postType));
  }
  const [row] = await db
    .select({
      accountId: productionItems.accountId,
      totalViews: sql<number>`coalesce(sum(${productionItems.views}), 0)`.as(
        "total_views",
      ),
      itemCount: sql<number>`count(*)`.as("item_count"),
      mostRecent: sql`max(${productionItems.publishedAt})`.as("most_recent"),
    })
    .from(productionItems)
    .where(and(...conditions))
    .groupBy(productionItems.accountId)
    .orderBy(
      sql`coalesce(sum(${productionItems.views}), 0) desc`,
      sql`max(${productionItems.publishedAt}) desc nulls last`,
      desc(sql`count(*)`),
    )
    .limit(1);
  if (!row || !row.accountId) return null;
  return {
    accountId: row.accountId,
    totalViews: Number(row.totalViews ?? 0),
    itemCount: Number(row.itemCount ?? 0),
  };
}

// Replace a format's channels with `inputs`. Idempotent: deletes existing
// rows then inserts the new set, all inside a single transaction.
export async function setFormatChannels(
  formatId: string,
  inputs: FormatChannelInput[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(formatChannels).where(eq(formatChannels.formatId, formatId));
    if (inputs.length > 0) {
      // Dedupe by (accountId, postType) to satisfy the unique index.
      const seen = new Set<string>();
      const rows: { formatId: string; accountId: string; postType: string | null }[] = [];
      for (const i of inputs) {
        const key = `${i.accountId}|${i.postType ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          formatId,
          accountId: i.accountId,
          postType: i.postType ?? null,
        });
      }
      if (rows.length) await tx.insert(formatChannels).values(rows);
    }
  });
}
