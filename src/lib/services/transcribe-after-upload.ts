import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";

/**
 * Fire-and-forget: if an item has video/audio media archived to S3 and
 * isn't already transcribed, enqueue a Whisper transcribe run.
 *
 * Called from every site that finishes writing `mediaS3Key`:
 *   - enrichment orchestrator (IG / TikTok / Threads / X / LinkedIn /
 *     YouTube Community carousel + primary-media archive)
 *   - youtube-download task (yt-dlp pulls the full long-form video)
 *   - uploads/confirm route (user uploads a file directly)
 *
 * Guarded by WHISPER_TRANSCRIBE_LIVE so transcription can be disabled
 * without a code change if OpenAI spend needs capping. Default is enabled
 * (flag unset or not "false" means live); this is a kill switch, not a
 * rollout gate.
 *
 * Does not throw — logs and swallows so a failed enqueue never fails the
 * surrounding archive.
 */
export async function maybeEnqueueWhisperTranscribe(
  productionItemId: string,
): Promise<void> {
  if (process.env.WHISPER_TRANSCRIBE_LIVE === "false") return;

  try {
    const [item] = await db
      .select({
        mediaS3Key: productionItems.mediaS3Key,
        mediaContentType: productionItems.mediaContentType,
      })
      .from(productionItems)
      .where(eq(productionItems.id, productionItemId))
      .limit(1);

    if (!item) return;
    if (!item.mediaS3Key) return;

    const ct = item.mediaContentType ?? "";
    if (!ct.startsWith("video/") && !ct.startsWith("audio/")) return;

    // Skip if we already have a transcript (Whisper or legacy Descript).
    const [existingTranscript] = await db
      .select({ id: transcripts.id, fullText: transcripts.fullText })
      .from(transcripts)
      .where(eq(transcripts.productionItemId, productionItemId))
      .limit(1);
    if (existingTranscript && existingTranscript.fullText.length > 0) return;

    await enqueue(
      "transcribe-whisper",
      { productionItemId },
      { jobKey: `transcribe-whisper:${productionItemId}` },
    );
  } catch (err) {
    console.warn(
      `[maybeEnqueueWhisperTranscribe] failed for ${productionItemId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
