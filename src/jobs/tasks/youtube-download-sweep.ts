import type { Task } from "graphile-worker";
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import type { YoutubeDownloadPayload } from "./youtube-download";

// Batch size per tick. The cron fires every 20 min, the worker concurrency is
// 4, and a typical video takes ~20–60s end-to-end, so 50 per tick leaves
// plenty of headroom while making steady progress through the backlog.
const SWEEP_BATCH_SIZE = 50;

// Give up on an item after this many failures. Prevents permanently-broken
// videos (deleted, private, age-gated without cookies) from burning the queue.
const MAX_ATTEMPTS = 5;

/**
 * Parent task: selects the next batch of published YouTube videos that don't
 * yet have an S3 archive and enqueues one `youtube-download` child per item.
 * Dedupes against in-flight attempts via jobKey.
 *
 * **Production-disabled (2026-05-15):** YouTube bot-blocks Heroku's IP range
 * — every yt-dlp call from the worker dyno fails with "Sign in to confirm
 * you're not a bot" and the dead-job table grew to ~3K rows over 3 weeks.
 * Local workers have browser cookies and succeed. So the sweep is a no-op
 * in prod and runs normally in dev. If we ever route the download through
 * a residential proxy or a cookies-from-browser cron on a non-Heroku host,
 * lift this gate.
 */
export const youtubeDownloadSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  if (process.env.NODE_ENV === "production") {
    helpers.logger.info(
      "youtube-download-sweep noop (NODE_ENV=production — YouTube bot-blocks the dyno IP)",
    );
    return;
  }
  helpers.logger.info("youtube-download-sweep start");

  const candidates = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.youtubeId),
        isNull(productionItems.mediaS3Key),
        lt(productionItems.youtubeDownloadAttempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(desc(productionItems.publishedDate))
    .limit(SWEEP_BATCH_SIZE);

  for (const { id } of candidates) {
    const payload: YoutubeDownloadPayload = { productionItemId: id };
    await helpers.addJob("youtube-download", payload as never, {
      jobKey: `yt-dl-${id}`,
      jobKeyMode: "unsafe_dedupe",
      // Bot-check / age-gated / deleted are deterministic — graphile's default
      // 25 retries just burns worker slots. The sweep's `youtubeDownloadAttempts < MAX_ATTEMPTS`
      // gate already paces retries across sweep cycles.
      maxAttempts: 2,
    });
  }

  helpers.logger.info(
    `youtube-download-sweep fanned out ${candidates.length} items (${Date.now() - start}ms)`,
  );
};
