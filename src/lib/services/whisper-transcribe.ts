// Lightweight transcript accessor — the ONLY part of the Whisper pipeline
// that API routes import. The heavy ffmpeg + OpenAI pipeline lives in
// `src/jobs/tasks/whisper-pipeline.ts`, kept out of this file because
// `@ffmpeg-installer/<platform>` subpackages don't resolve statically
// under Next.js/Turbopack when the file is pulled into an API route's
// bundle. Worker code imports the pipeline; route code imports this.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { transcripts } from "@/lib/db/schema";

export interface TranscriptPromptPayload {
  fullText: string;
  segmentsMarkdown: string;
  durationSec: number;
  // Word-level timestamps from Whisper. Empty array on legacy
  // source='descript' rows (no per-word timing) — V7 anchor matching will
  // skip those gracefully (every quote will fail to match, the agent will
  // get a retry prompt, and the operator can re-run after re-transcribing).
  words: Array<{ word: string; startSec: number; endSec: number }>;
}

function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * The single seam between transcript ingestion (Stage 1) and LLM callers
 * (clip-idea agent, extract-hook). Returns null when no transcript exists
 * for the item. segmentsMarkdown formats each segment as
 * `[MM:SS] speaker?: text` so the model can cite timestamps.
 *
 * Shape is unchanged from the prior Descript-era implementation; legacy
 * `source='descript'` rows render through this just fine.
 */
export async function getTranscriptForPrompt(
  productionItemId: string,
): Promise<TranscriptPromptPayload | null> {
  const [row] = await db
    .select({
      fullText: transcripts.fullText,
      segments: transcripts.segments,
      words: transcripts.words,
      durationSec: transcripts.durationSec,
    })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);

  if (!row) return null;

  const segmentsMarkdown = row.segments
    .map((s) => {
      const ts = formatTimestamp(s.startSec);
      return s.speaker
        ? `[${ts}] ${s.speaker}: ${s.text}`
        : `[${ts}] ${s.text}`;
    })
    .join("\n");

  // V7 anchor matching needs word-level timestamps. Whisper rows carry them
  // natively; legacy `source='descript'` rows (and any future source that
  // doesn't expose words) only have segment-level timing. Synthesize a words
  // array by spreading each segment's words evenly across its time range —
  // less precise than real word timestamps but lets the matcher work.
  const words: Array<{ word: string; startSec: number; endSec: number }> =
    row.words && row.words.length > 0
      ? row.words
      : synthesizeWordsFromSegments(row.segments);

  return {
    fullText: row.fullText,
    segmentsMarkdown,
    durationSec: Number(row.durationSec ?? 0),
    words,
  };
}

function synthesizeWordsFromSegments(
  segments: Array<{ startSec: number; endSec: number; text: string }>,
): Array<{ word: string; startSec: number; endSec: number }> {
  const out: Array<{ word: string; startSec: number; endSec: number }> = [];
  for (const seg of segments) {
    const tokens = seg.text.split(/(\s+)/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const wordTokens = tokens.filter((t) => /\S/.test(t));
    if (wordTokens.length === 0) continue;
    const span = Math.max(0, seg.endSec - seg.startSec);
    const perWord = wordTokens.length > 0 ? span / wordTokens.length : 0;
    let i = 0;
    for (const token of wordTokens) {
      const start = seg.startSec + i * perWord;
      const end = seg.startSec + (i + 1) * perWord;
      out.push({ word: token, startSec: start, endSec: end });
      i++;
    }
  }
  return out;
}
