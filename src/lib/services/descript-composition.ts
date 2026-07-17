import { and, eq, ne } from "drizzle-orm";

import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

/**
 * Compose a Descript composition name that includes the production_item_id
 * so editors can match a composition back to its row in Hub & Spoke.
 *
 * Format: `<title> [<production_item_id>]`. The bracketed UUID is searchable
 * in Descript's project sidebar — editors paste the UUID into the find box
 * (or grep their browser's address bar) and land on the right composition.
 *
 * `title` is trimmed and falls back to an item-id-derived stub when empty;
 * the production_item_id is always present.
 */
// Descript enforces a ~255-char project name limit and returns a generic
// 500 when exceeded. The UUID suffix is always 39 chars (` [<uuid>]`),
// so cap the title at 200 to leave a safe margin.
const MAX_TITLE_LENGTH = 200;

export function buildCompositionName(args: {
  title: string | null | undefined;
  productionItemId: string;
}): string {
  const cleanTitle = (args.title ?? "").trim();
  const raw = cleanTitle.length > 0 ? cleanTitle : `Item ${args.productionItemId.slice(0, 8)}`;
  const head = raw.length > MAX_TITLE_LENGTH ? raw.slice(0, MAX_TITLE_LENGTH).trimEnd() + "…" : raw;
  return `${head} [${args.productionItemId}]`;
}

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
