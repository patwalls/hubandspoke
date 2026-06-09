import type { JobHelpers, Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { transcripts } from "@/lib/db/schema";
import { selectAutoClipIdeaJobs } from "@/lib/services/clip-ideas-auto";
import {
  extractAudioToS3,
  transcribeFromS3Audio,
  type AudioChunk,
} from "./whisper-pipeline";

export interface TranscribeWhisperPayload {
  productionItemId: string;
  /** Set after phase 1 uploads the extracted audio chunks to S3. */
  audioS3Key?: string;
  audioS3Bucket?: string;
  /** Ordered chunk manifest produced by phase 1. For short audio (<10 min)
   *  this is a single-element array; for podcast-length content it's the
   *  set of ~10-min splits that fit under Whisper's 25 MB cap. */
  audioChunks?: AudioChunk[];
}

/**
 * Whisper-based transcription. Two phases split across graphile-worker
 * invocations so a dyno SIGTERM mid-work lets the second half retry cheaply:
 *
 *   Phase 1 (no audioS3Key): download the archived video from S3, extract
 *      mono 16kHz opus audio with ffmpeg's segment muxer (10-min chunks),
 *      upload each chunk to S3. Re-enqueue self with the chunk manifest
 *      carried on the payload.
 *   Phase 2 (audioS3Key set): iterate chunks, call OpenAI Whisper per
 *      chunk (with an item-aware prompt to bias proper nouns), offset
 *      chunk-local timestamps, merge, upsert the `transcripts` row.
 *
 * Idempotent at the top: if a row with non-empty fullText exists for this
 * item, exit — don't burn another API call.
 */
export const transcribeWhisperTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as TranscribeWhisperPayload;
  const { productionItemId } = payload;

  const [existing] = await db
    .select({
      source: transcripts.source,
      fullText: transcripts.fullText,
    })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);
  if (existing && existing.fullText && existing.fullText.length > 0) {
    helpers.logger.info(
      `transcribe-whisper skip item=${productionItemId} — transcript already exists (source=${existing.source})`,
    );
    return;
  }

  // Phase 2: audio already in S3 — run Whisper per chunk.
  if (payload.audioS3Key && payload.audioS3Bucket) {
    await transcribeFromS3Audio(
      productionItemId,
      payload.audioS3Key,
      payload.audioS3Bucket,
      payload.audioChunks ?? null,
      helpers.logger,
    );
    await maybeAutoEnqueueClipIdeas(productionItemId, helpers);
    return;
  }

  // Phase 1: extract audio, split into chunks, re-enqueue.
  const { audioS3Bucket, audioS3Key, chunks } = await extractAudioToS3(
    productionItemId,
    helpers.logger,
  );
  await helpers.addJob(
    "transcribe-whisper",
    { productionItemId, audioS3Key, audioS3Bucket, audioChunks: chunks },
    { runAt: new Date(Date.now() + 1000) },
  );
};

/**
 * Auto clip-idea generation for NEW Starter Story long-form (2026-06-09).
 * Fires once, right after the transcript lands — the only moment the full
 * (media + transcript) precondition is freshly true. All cost gates live in
 * `clip-ideas-auto.ts` (brand allowlist, Published + original + youtube_long,
 * ≤7-day recency so whisper backfills over old videos never fan out).
 *
 * Best-effort by design: the transcript row is already committed, and a
 * worker retry of this task would hit the transcript-exists skip at the top
 * and never reach this point again — so a throw here would lose the enqueue
 * AND fail a task that actually succeeded. Log and move on instead; the
 * manual Generate button remains the fallback.
 */
async function maybeAutoEnqueueClipIdeas(
  productionItemId: string,
  helpers: JobHelpers,
): Promise<void> {
  try {
    const result = await selectAutoClipIdeaJobs(productionItemId);
    if (!result.eligible) {
      helpers.logger.info(
        `transcribe-whisper auto-clip-ideas skip item=${productionItemId} reason=${result.reason}`,
      );
      return;
    }
    for (const job of result.jobs) {
      await helpers.addJob(
        "generate-clip-ideas",
        { productionItemId, targetFormatId: job.targetFormatId },
        { jobKey: `auto-clip-ideas-${productionItemId}-${job.targetFormatId}` },
      );
    }
    helpers.logger.info(
      `transcribe-whisper auto-clip-ideas enqueued item=${productionItemId} formats=${result.jobs
        .map((j) => j.formatName)
        .join(",")}`,
    );
  } catch (err) {
    helpers.logger.error(
      `transcribe-whisper auto-clip-ideas failed item=${productionItemId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
