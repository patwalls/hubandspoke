import { and, eq, ne } from "drizzle-orm";

import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

/**
 * Throws if `compositionId` is already on a production_item other than
 * `intendedItemId`. Belt-and-suspenders alongside the unique partial index on
 * `production_items.descript_composition_id`: this fires before the UPDATE so
 * the error message names both rows.
 *
 * One composition belongs to one derivative. Pillars hold a
 * `descript_seed_composition_id` instead (the same Descript composition can
 * be referenced as a seed AND as a derivative's own composition without
 * violating uniqueness — they live in different columns).
 */
export async function assertCompositionUnique(args: {
  compositionId: string;
  intendedItemId: string;
}): Promise<void> {
  const { compositionId, intendedItemId } = args;
  const [collision] = await db
    .select({ id: productionItems.id, title: productionItems.title })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.descriptCompositionId, compositionId),
        ne(productionItems.id, intendedItemId),
      ),
    )
    .limit(1);
  if (collision) {
    throw new Error(
      `Descript composition ${compositionId} is already attached to production_item ${collision.id} (${collision.title ?? "untitled"}); refusing to stamp it on ${intendedItemId}`,
    );
  }
}
