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
  // Word-level timestamps from Whisper. Required by V7 anchor matching.
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

  return {
    fullText: row.fullText,
    segmentsMarkdown,
    durationSec: Number(row.durationSec ?? 0),
    words: row.words ?? [],
  };
}
