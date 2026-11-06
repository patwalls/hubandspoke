/**
 * Loads a format's trim habit (project "clip trim", M1): the brand + format's
 * last edited clips (revision > 1, last 60 days) with the AI window their clip
 * idea started from. Pure math in `src/lib/clip-editor/trim-habits.ts`.
 *
 * Read once per clip-idea generation run (worker), like `loadHookRewrites`.
 * Fail-soft: the caller treats a throw as "no habit".
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, productionItems } from "@/lib/db/schema";
import { parseDoc } from "@/lib/clip-editor/doc";
import { summarizeTrims, type TrimSummary } from "@/lib/clip-editor/trim-habits";
import { RECENT_CLIPS, WINDOW_DAYS } from "./hook-rewrites";

export async function loadTrimHabits(args: { brand: string; formatName: string; now?: Date }): Promise<TrimSummary | null> {
  const since = new Date((args.now ?? new Date()).getTime() - WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ doc: clipEdits.doc, startSec: clipIdeas.startSec, endSec: clipIdeas.endSec })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(and(eq(productionItems.brand, args.brand), eq(clipIdeas.targetFormat, args.formatName), gt(clipEdits.updatedAt, since), gt(clipEdits.revision, 1)))
    .orderBy(desc(clipEdits.updatedAt))
    .limit(RECENT_CLIPS);
  return summarizeTrims(
    rows.flatMap((r) => {
      const parsed = parseDoc(r.doc);
      return parsed.ok ? [{ startSec: Number(r.startSec), endSec: Number(r.endSec), doc: parsed.doc }] : [];
    }),
  );
}
