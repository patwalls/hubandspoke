/**
 * Decide whether a transcript should get speaker detection, and queue it.
 * Lightweight (no ffmpeg / OpenAI imports) so API routes can call it too.
 *
 * Cost shape, measured 2026-09-17 on a real two-person interview:
 * ~$0.22 and ~4.7 minutes of API time per 10 minutes of audio. Hence the
 * gates below, and hence a dedicated serialized queue.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { transcripts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";

/** Short-form (reels, shorts) is overwhelmingly one voice; labelling it costs
 *  money to tell us nothing. Long-form is where speakers matter. */
export const DIARIZE_MIN_DURATION_SEC = 120;

export type DiarizeSkipReason =
  | "disabled"
  | "no_transcript"
  | "not_whisper"
  | "no_audio"
  | "too_short"
  | "already_done";

export async function maybeEnqueueDiarize(
  productionItemId: string,
  opts: {
    /** Re-run even if speakers were already detected (a re-transcription
     *  passes this — its words are new). */
    force?: boolean;
    /** Skip the duration gate (the manual "Detect speakers" button). */
    ignoreDuration?: boolean;
    /** Backfills use their own queue so they never delay a fresh video. */
    queueName?: "diarize" | "diarize-backfill";
  } = {},
): Promise<{ enqueued: true } | { enqueued: false; reason: DiarizeSkipReason }> {
  // Operational kill switch, same convention as WHISPER_TRANSCRIBE_LIVE.
  if (process.env.DIARIZE_LIVE === "false") return { enqueued: false, reason: "disabled" };

  const [t] = await db
    .select({
      source: transcripts.source,
      audioChunks: transcripts.audioChunks,
      audioS3Key: transcripts.audioS3Key,
      durationSec: transcripts.durationSec,
      diarizedAt: transcripts.diarizedAt,
    })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);
  if (!t) return { enqueued: false, reason: "no_transcript" };
  // Caption-scrape transcripts have no audio of ours and no word timings.
  if (t.source !== "whisper") return { enqueued: false, reason: "not_whisper" };
  if (!t.audioS3Key && !(t.audioChunks && t.audioChunks.length > 0)) {
    return { enqueued: false, reason: "no_audio" };
  }
  if (!opts.ignoreDuration && Number(t.durationSec ?? 0) < DIARIZE_MIN_DURATION_SEC) {
    return { enqueued: false, reason: "too_short" };
  }
  if (t.diarizedAt && !opts.force) return { enqueued: false, reason: "already_done" };

  await enqueue(
    "diarize-transcript",
    {
      productionItemId,
      queue: opts.queueName ?? "diarize",
      ...(opts.force ? { force: true } : {}),
    },
    {
      jobKey: `diarize:${productionItemId}`,
      jobKeyMode: "replace",
      queueName: opts.queueName ?? "diarize",
      maxAttempts: 5,
    },
  );
  return { enqueued: true };
}
