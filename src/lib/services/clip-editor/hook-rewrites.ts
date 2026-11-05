/**
 * Loads a format's recent hook rewrites (project "hooks learn"): the brand +
 * format's last edited clips (revision > 1, last 60 days), paired with the AI
 * hook their clip idea started from. Pure pairing in
 * `src/lib/clip-editor/hook-rewrites.ts`.
 *
 * - `loadHookRewrites` — M1, the clip-idea hook writer's pairs. Read once per
 *   generation run (worker). Fail-soft: the caller treats a throw as "no pairs".
 * - `loadHookRewriteSummary` — M2, the format page's "Editors rewrite the AI
 *   hook on N of M clips" line. Same rows, so the page shows exactly what the
 *   writer learns from. Read on page open; one indexed join capped at
 *   RECENT_CLIPS rows, so no cache.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, productionItems } from "@/lib/db/schema";
import { parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";
import { collectHookRewrites, summarizeHookRewrites, type HookRewrite, type HookRewriteSummary } from "@/lib/clip-editor/hook-rewrites";

export const RECENT_CLIPS = 40;
export const WINDOW_DAYS = 60;

interface LoadArgs {
  brand: string;
  formatName: string;
  now?: Date;
}

async function loadRows(args: LoadArgs): Promise<Array<{ aiHook: string | null; doc: ClipEditDoc }>> {
  const since = new Date((args.now ?? new Date()).getTime() - WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ doc: clipEdits.doc, aiHook: clipIdeas.hook })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(and(eq(productionItems.brand, args.brand), eq(clipIdeas.targetFormat, args.formatName), gt(clipEdits.updatedAt, since), gt(clipEdits.revision, 1)))
    .orderBy(desc(clipEdits.updatedAt))
    .limit(RECENT_CLIPS);
  return rows.flatMap((r) => {
    const parsed = parseDoc(r.doc);
    return parsed.ok ? [{ aiHook: r.aiHook, doc: parsed.doc }] : [];
  });
}

export async function loadHookRewrites(args: LoadArgs): Promise<HookRewrite[]> {
  return collectHookRewrites(await loadRows(args));
}

export async function loadHookRewriteSummary(args: LoadArgs): Promise<HookRewriteSummary | null> {
  return summarizeHookRewrites(await loadRows(args));
}
