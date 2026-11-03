/**
 * Brand spellings (fix-names-once M3) — names the team fixed in clips of two
 * or more different videos of a brand, learned from those clips' edit docs
 * and offered on any other clip of the brand. See `learnBrandSpellings` in
 * `@/lib/clip-editor/carry-fixes` for the rules.
 *
 * Learning needs each video's transcript (a correction is keyed by the word's
 * time in ITS video), so it reads the most recent `MAX_VIDEOS` videos that
 * have corrections and keeps the answer in memory per brand for
 * `TTL_MS` — the editor opens a few dozen times a day, so this is one
 * transcript sweep per brand per half hour at most, never per open.
 */
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, productionItems, transcripts } from "@/lib/db/schema";
import { parseDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";
import { resolveTranscriptWords } from "@/lib/clip-editor/words";
import { learnBrandSpellings, type BrandSpelling } from "@/lib/clip-editor/carry-fixes";

const MAX_VIDEOS = 15;
const LOOKBACK_DAYS = 90;
const TTL_MS = 30 * 60 * 1000;

const cache = new Map<string, { at: number; spellings: BrandSpelling[] }>();

/** Test hook: forget what was learned. */
export function clearBrandSpellingsCache() {
  cache.clear();
}

export async function loadBrandSpellings(brand: string, now = Date.now()): Promise<BrandSpelling[]> {
  return cached(`offer:${brand}`, now, () => learn(brand, now, 2));
}

/**
 * The brand's vocabulary for transcription (fix-names-once M4): every name
 * the team fixed by hand in a recent clip of this brand — ONE video is
 * enough here, unlike the editor offer, because a Whisper prompt only nudges
 * spelling (a wrong entry costs nothing), while a missing one means the next
 * video gets the same name wrong in every clip. Most-fixed first.
 */
export async function loadBrandVocabulary(brand: string, now = Date.now()): Promise<string[]> {
  const spellings = await cached(`vocab:${brand}`, now, () => learn(brand, now, 1));
  return [...spellings].sort((a, b) => b.videos - a.videos).map((s) => s.replacement);
}

async function cached(key: string, now: number, run: () => Promise<BrandSpelling[]>) {
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.spellings;
  const spellings = await run();
  cache.set(key, { at: now, spellings });
  return spellings;
}

async function learn(brand: string, now: number, minVideos: number): Promise<BrandSpelling[]> {
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000);
  const rows = await db
    .select({ sourceId: clipIdeas.sourceProductionItemId, doc: clipEdits.doc, updatedAt: clipEdits.updatedAt })
    .from(clipEdits)
    .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(
      and(
        eq(productionItems.brand, brand),
        gt(clipEdits.updatedAt, since),
        sql`${clipEdits.doc}->'wordEdits' <> '{}'::jsonb`,
      ),
    )
    .orderBy(desc(clipEdits.updatedAt))
    .limit(200);
  // The most recent videos with corrections; fewer videos than a spelling
  // needs means there's nothing to learn.
  const videos = [...new Set(rows.map((r) => r.sourceId))].slice(0, MAX_VIDEOS);
  if (videos.length < minVideos) return [];

  const ts = await db
    .select({ productionItemId: transcripts.productionItemId, words: transcripts.words, segments: transcripts.segments })
    .from(transcripts)
    .where(inArray(transcripts.productionItemId, videos))
    .orderBy(asc(transcripts.productionItemId));
  const wordsBy = new Map(ts.map((t) => [t.productionItemId, resolveTranscriptWords(t).words]));

  const edits: { sourceId: string; doc: ClipEditDoc; words: ReturnType<typeof resolveTranscriptWords>["words"] }[] = [];
  for (const r of [...rows].reverse()) {
    const words = wordsBy.get(r.sourceId);
    if (!words) continue;
    const parsed = parseDoc(r.doc);
    if (parsed.ok) edits.push({ sourceId: r.sourceId, doc: parsed.doc, words });
  }
  return learnBrandSpellings(edits, minVideos);
}
