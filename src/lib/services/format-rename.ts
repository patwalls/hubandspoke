/**
 * Format-rename cascade.
 *
 * A format is identified by the pair (brand, name). Several columns link to a
 * format by storing its NAME as a plain string rather than a FK to
 * `formats.id`:
 *   - `production_items.format`        (brand co-located on the same row)
 *   - `clip_ideas.target_format`       (brand derived via source production item)
 *   - `clip_ideas.accepted_target_format` (same join path)
 *
 * Renaming a format therefore has to carry every referencing row along with it,
 * or those rows silently orphan — which is exactly what stranded ~4000 clip
 * ideas behind a "Failed (502)" when the my-first-million / futurepedia clip
 * formats were renamed (see promote-clip-idea.ts loadPromotedClipFormat). This
 * module is the single place that knows the full reference set, so the rename
 * stays complete and brand-scoped.
 *
 * Brand scoping is non-negotiable: the same name can exist under two brands
 * (e.g. "X Quotables" on both matg and starter-story), so an unscoped rename
 * would corrupt the other brand's rows.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems } from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Accept either the root client or an open transaction. The cascade should
 *  always run inside a transaction with the `formats.name` UPDATE so a partial
 *  failure rolls back; the loose type just keeps callers flexible. */
type DbOrTx = typeof db | Tx;

export interface FormatRenameImpact {
  /** production_items rows whose `format` equals the name (brand-scoped). */
  productionItems: number;
  /** clip_ideas rows referencing the name via target/accepted (brand-scoped). */
  clipIdeas: number;
}

/** ids of every production item on the brand — the bridge used to brand-scope
 *  clip_ideas, which has no brand column of its own. */
function brandItemIds(executor: DbOrTx, brand: string) {
  return executor
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.brand, brand));
}

/**
 * Count the rows a rename of (brand, name) would touch, so the UI can show the
 * blast radius before the editor commits. Read-only.
 */
export async function countFormatRenameImpact(args: {
  brand: string;
  name: string;
}): Promise<FormatRenameImpact> {
  const [pi] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, args.brand),
        eq(productionItems.format, args.name),
      ),
    );

  const [ci] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clipIdeas)
    .where(
      and(
        inArray(clipIdeas.sourceProductionItemId, brandItemIds(db, args.brand)),
        sql`(${clipIdeas.targetFormat} = ${args.name} OR ${clipIdeas.acceptedTargetFormat} = ${args.name})`,
      ),
    );

  return { productionItems: pi?.n ?? 0, clipIdeas: ci?.n ?? 0 };
}

/**
 * Rewrite every string reference from `oldName` → `newName`, brand-scoped.
 * MUST run inside the same transaction as the `formats.name` UPDATE so the
 * format row and its references commit or roll back together. Returns the
 * number of rows actually changed.
 */
export async function cascadeFormatRename(
  tx: DbOrTx,
  args: { brand: string; oldName: string; newName: string },
): Promise<FormatRenameImpact> {
  const items = await tx
    .update(productionItems)
    .set({ format: args.newName, updatedAt: new Date() })
    .where(
      and(
        eq(productionItems.brand, args.brand),
        eq(productionItems.format, args.oldName),
      ),
    )
    .returning({ id: productionItems.id });

  const target = await tx
    .update(clipIdeas)
    .set({ targetFormat: args.newName })
    .where(
      and(
        eq(clipIdeas.targetFormat, args.oldName),
        inArray(
          clipIdeas.sourceProductionItemId,
          brandItemIds(tx, args.brand),
        ),
      ),
    )
    .returning({ id: clipIdeas.id });

  await tx
    .update(clipIdeas)
    .set({ acceptedTargetFormat: args.newName })
    .where(
      and(
        eq(clipIdeas.acceptedTargetFormat, args.oldName),
        inArray(
          clipIdeas.sourceProductionItemId,
          brandItemIds(tx, args.brand),
        ),
      ),
    );

  return { productionItems: items.length, clipIdeas: target.length };
}
