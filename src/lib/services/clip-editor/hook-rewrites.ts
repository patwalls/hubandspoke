/**
 * Loads a format's recent hook rewrites for the clip-idea hook writer
 * (project "hooks learn", M1): the brand + format's last edited clips
 * (revision > 1, last 60 days), paired with the AI hook their clip idea
 * started from. Pure pairing in `src/lib/clip-editor/hook-rewrites.ts`.
 *
 * Read once per clip-idea generation run (worker), one indexed join capped
 * at RECENT_CLIPS rows. Fail-soft: the caller treats a throw as "no pairs".
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, productionItems } from "@/lib/db/schema";
import { parseDoc } from "@/lib/clip-editor/doc";
import { collectHookRewrites, type HookRewrite } from "@/lib/clip-editor/hook-rewrites";

export const RECENT_CLIPS = 40;
export const WINDOW_DAYS = 60;

export async function loadHookRewrites(args: { brand: string; formatName: string; now?: Date }): Promise<HookRewrite[]> {
  const since = new Date((args.now ?? new Date()).getTime() - WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ doc: clipEdits.doc, aiHook: clipIdeas.hook })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(and(eq(productionItems.brand, args.brand), eq(clipIdeas.targetFormat, args.formatName), gt(clipEdits.updatedAt, since), gt(clipEdits.revision, 1)))
    .orderBy(desc(clipEdits.updatedAt))
    .limit(RECENT_CLIPS);
  return collectHookRewrites(
    rows.flatMap((r) => {
      const parsed = parseDoc(r.doc);
      return parsed.ok ? [{ aiHook: r.aiHook, doc: parsed.doc }] : [];
    }),
  );
}
