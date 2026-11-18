/**
 * Loads a format's trim habit (project "clip trim", M1): the brand + format's
 * last edited clips (revision > 1, last 60 days) with the AI window their clip
 * idea started from. Pure math in `src/lib/clip-editor/trim-habits.ts`.
 *
 * Read once per clip-idea generation run (worker), like `loadHookRewrites`.
 * Fail-soft: the caller treats a throw as "no habit".
 *
 * `withEndings` (the writer only, clip-trim M3): also quote where the AI's
 * window ended vs where the editor ended, from the source transcripts of the
 * newest clips whose end was cut — one extra query for at most
 * MAX_ENDING_PAIRS × 2 transcripts. The format page and the editor don't ask.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, productionItems, transcripts } from "@/lib/db/schema";
import { parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";
import { resolveTranscriptWords } from "@/lib/clip-editor/words";
import { clipTrim, endingPairs, MAX_ENDING_PAIRS, MIN_TRIM_SEC, summarizeTrims, type TrimSummary } from "@/lib/clip-editor/trim-habits";
import { RECENT_CLIPS, WINDOW_DAYS } from "./hook-rewrites";

export async function loadTrimHabits(args: { brand: string; formatName: string; now?: Date; withEndings?: boolean }): Promise<TrimSummary | null> {
  const since = new Date((args.now ?? new Date()).getTime() - WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ doc: clipEdits.doc, startSec: clipIdeas.startSec, endSec: clipIdeas.endSec, sourceItemId: clipIdeas.sourceProductionItemId })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(and(eq(productionItems.brand, args.brand), eq(clipIdeas.targetFormat, args.formatName), gt(clipEdits.updatedAt, since), gt(clipEdits.revision, 1)))
    .orderBy(desc(clipEdits.updatedAt))
    .limit(RECENT_CLIPS);
  const parsed = rows.flatMap((r) => {
    const p = parseDoc(r.doc);
    return p.ok ? [{ startSec: Number(r.startSec), endSec: Number(r.endSec), doc: p.doc, sourceItemId: r.sourceItemId }] : [];
  });
  const summary = summarizeTrims(parsed);
  if (!summary || !args.withEndings || summary.tailCut === 0) return summary;
  return { ...summary, endings: await loadEndings(parsed) };
}

async function loadEndings(rows: Array<{ startSec: number; endSec: number; doc: ClipEditDoc; sourceItemId: string | null }>) {
  // Newest tail-cut clips first; a couple spare in case a transcript is missing.
  const cut = rows
    .filter((r) => r.sourceItemId && (clipTrim(r, r.doc)?.tailSec ?? 0) >= MIN_TRIM_SEC)
    .slice(0, MAX_ENDING_PAIRS * 2);
  const ids = [...new Set(cut.map((r) => r.sourceItemId!))];
  if (ids.length === 0) return [];
  const ts = await db
    .select({ itemId: transcripts.productionItemId, words: transcripts.words, segments: transcripts.segments })
    .from(transcripts)
    .where(inArray(transcripts.productionItemId, ids));
  const wordsByItem = new Map(ts.map((t) => [t.itemId, resolveTranscriptWords(t).words]));
  return endingPairs(cut.flatMap((r) => {
    const words = wordsByItem.get(r.sourceItemId!);
    return words ? [{ ...r, words }] : [];
  }));
}
