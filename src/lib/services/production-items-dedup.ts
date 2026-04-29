import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import { and, eq, isNull, ne } from "drizzle-orm";

export type DuplicateMatch = {
  id: string;
  accountHandle: string | null;
  platformContentId: string | null;
  publishedLink: string | null;
};

/**
 * Find a non-deleted production_item that already owns the same platform-
 * native id (X rest_id, YT videoId, IG shortcode, …). Used as a friendly
 * pre-check by the API + sync paths so we surface the existing item id
 * instead of letting the DB unique index throw an opaque 23505. The DB
 * index `uniq_production_items_platform_content_id_global` is the safety
 * net for race conditions.
 *
 * We deliberately do NOT match on `published_link` here. Placeholder URLs
 * (homepage, "Twitter Post", reused Klaviyo URLs) appear thousands of times
 * in legitimate rows; URL-based uniqueness would block correct usage. The
 * cleanup script `scripts/backfill-find-duplicates.mjs` still surfaces
 * URL-level collisions for manual audit.
 *
 * Returns null when `platformContentId` is null. Pass `excludeId` from PUT
 * handlers so saving an item to itself doesn't trip.
 */
export async function findCrossAccountDuplicate(opts: {
  platformContentId: string | null;
  excludeId?: string;
}): Promise<DuplicateMatch | null> {
  const { platformContentId, excludeId } = opts;
  if (!platformContentId) return null;

  const where = and(
    isNull(productionItems.deletedAt),
    eq(productionItems.platformContentId, platformContentId),
    excludeId ? ne(productionItems.id, excludeId) : undefined
  );

  const [row] = await db
    .select({
      id: productionItems.id,
      accountHandle: accounts.handle,
      platformContentId: productionItems.platformContentId,
      publishedLink: productionItems.publishedLink,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(where)
    .limit(1);

  return row ?? null;
}
