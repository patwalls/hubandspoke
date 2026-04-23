import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";

/**
 * Fire-and-forget: if an item has video/audio media archived to S3 and
 * isn't already transcribed (or mid-transcription), enqueue a Descript
 * transcribe run.
 *
 * Called from every site that finishes writing `mediaS3Key`:
 *   - enrichment orchestrator (IG / TikTok / Threads / X / LinkedIn /
 *     YouTube Community carousel + primary-media archive)
 *   - youtube-download task (yt-dlp pulls the full long-form video)
 *   - uploads/confirm route (user uploads a file directly)
 *
 * Guarded by DESCRIPT_TRANSCRIPT_FETCH_LIVE so the flag can be flipped off
 * if Descript spend needs capping without shipping a code change.
 *
 * Does not throw — logs and swallows so a failed enqueue never fails the
 * surrounding archive.
 */
export async function maybeEnqueueDescriptTranscribe(
  productionItemId: string,
): Promise<void> {
  if (process.env.DESCRIPT_TRANSCRIPT_FETCH_LIVE !== "true") return;

  try {
    const [item] = await db
      .select({
        mediaS3Key: productionItems.mediaS3Key,
        mediaContentType: productionItems.mediaContentType,
        descriptProjectId: productionItems.descriptProjectId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, productionItemId))
      .limit(1);

    if (!item) return;
    if (!item.mediaS3Key) return;

    // Audio transcription is fine; images and unknown types aren't
    // worth a Descript round trip.
    const ct = item.mediaContentType ?? "";
    if (!ct.startsWith("video/") && !ct.startsWith("audio/")) return;

    // If a Descript project already exists on this item (from precise-cut,
    // clip-out, or a prior transcribe run), assume the right pipeline is
    // already handling it and don't double-enqueue.
    if (item.descriptProjectId) return;

    const [existingTranscript] = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(eq(transcripts.productionItemId, productionItemId))
      .limit(1);
    if (existingTranscript) return;

    await enqueue("descript-transcribe", { productionItemId });
  } catch (err) {
    console.warn(
      `[maybeEnqueueDescriptTranscribe] failed for ${productionItemId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
