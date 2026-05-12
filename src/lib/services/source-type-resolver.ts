import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";

export type FormatBackedSourceType = "original" | "repurposed";

/**
 * Look up the `labels_as_original` flag on a (brand, format-name) pair to
 * decide whether new productionItems created in this format default to
 * `sourceType='original'` or `'repurposed'`. The flag lives on the format
 * row and is toggled via the format-detail-page checkbox.
 *
 * Used by every write site that creates a new productionItem with a
 * known format. Falls back to `"repurposed"` when:
 *   - format is null/empty
 *   - no matching formats row exists for (brand, name)
 *   - the row exists but `labels_as_original=false`
 *
 * Replaces the YT-long-form heuristic from the 2026-05-11 consolidation
 * backfill; going forward the source of truth is this flag.
 *
 * Callers that already have `pillarContentItemId` set should be
 * `'repurposed'` by definition (derivative of a pillar) — they don't
 * need to call this; they hardcode `'repurposed'`.
 */
export async function resolveSourceTypeForFormat(
  brand: string,
  format: string | null | undefined,
): Promise<FormatBackedSourceType> {
  if (!format) return "repurposed";
  const [row] = await db
    .select({ labelsAsOriginal: formats.labelsAsOriginal })
    .from(formats)
    .where(and(eq(formats.brand, brand), sql`lower(${formats.name}) = lower(${format})`))
    .limit(1);
  return row?.labelsAsOriginal ? "original" : "repurposed";
}
