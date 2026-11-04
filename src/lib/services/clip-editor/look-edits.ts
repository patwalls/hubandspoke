/**
 * What editors change in a format's clip look — the format page's Clip look
 * card line ("Editors change: hook hidden on 29 of 42 clips ›"). The clip
 * side of design-edits M2.
 *
 * Reads the format's most recent clip edits that started from the CURRENT
 * look (created after `clip_template_updated_at`) and that someone actually
 * edited (revision > 1), and rolls them up with `rollUpLookEdits`. Read on
 * page open; one indexed join capped at RECENT_CLIPS rows, so no cache.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, productionItems } from "@/lib/db/schema";
import { parseDoc, type ClipLook } from "@/lib/clip-editor/doc";
import { rollUpLookEdits, type LookEditRow } from "@/lib/clip-editor/look-edits";

/** How many recent clips a format page reads. */
export const RECENT_CLIPS = 40;
/** Below this many clips a share ("1 of 2") says nothing: show nothing. */
export const MIN_CLIPS = 3;

export interface LookEdits {
  clips: number;
  rows: LookEditRow[];
}

export async function loadLookEdits(args: { brand: string; formatName: string; look: ClipLook; lookSavedAt: Date }): Promise<LookEdits | null> {
  const rows = await db
    .select({ doc: clipEdits.doc })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(and(eq(productionItems.brand, args.brand), eq(clipIdeas.targetFormat, args.formatName), gt(clipEdits.createdAt, args.lookSavedAt), gt(clipEdits.revision, 1)))
    .orderBy(desc(clipEdits.updatedAt))
    .limit(RECENT_CLIPS);
  const samples = rows.flatMap((r) => {
    const parsed = parseDoc(r.doc);
    return parsed.ok ? [{ doc: parsed.doc, look: args.look }] : [];
  });
  if (samples.length < MIN_CLIPS) return null;
  const out = rollUpLookEdits(samples);
  return out.length ? { clips: samples.length, rows: out } : null;
}
