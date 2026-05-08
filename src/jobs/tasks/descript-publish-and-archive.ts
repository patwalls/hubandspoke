import type { Task } from "graphile-worker";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, productionItemMedia } from "@/lib/db/schema";
import {
  DESCRIPT_EXPORT_URL_PREFIX,
  fetchDescriptJob,
  publishDescriptComposition,
} from "@/lib/descript";
import { archiveRemoteToS3 } from "@/lib/services/enrichment/shared";
import { addMediaRowsToDraft } from "@/lib/services/draft-media";
import { bucketName } from "@/lib/s3";

export interface DescriptPublishAndArchivePayload {
  productionItemId: string;
  /** Set after the first invocation kicks off the publish. Subsequent
   *  re-enqueues poll the job. Null on the first call. */
  publishJobId?: string;
  /** Epoch ms. Set on first invocation; carried forward. */
  deadlineAt?: number;
  /** Override the "already rendered" idempotency guard. Used by the manual
   *  Sync from Descript path so an editor can pull fresh edits. */
  force?: boolean;
}

const POLL_INTERVAL_MS = 10_000;
const DEADLINE_MS = 15 * 60 * 1000; // Descript publish jobs are typically ~2 min, generous cap

/**
 * Render a Descript composition to MP4, download the result, and archive
 * it to our S3 bucket as a `production_item_media` row. Mirrors the
 * `descript-clip-resolve` shape: each invocation does one HTTP round-trip
 * + DB write, then re-enqueues itself with a 10s delay if the job's still
 * running. Keeps each tick <1s so SIGTERM during a deploy never catches
 * us mid-poll.
 *
 * Two phases:
 *   1. First call (no `publishJobId`): POSTs /jobs/publish, stamps
 *      `descript_publish_job_id`, re-enqueues with the job id.
 *   2. Polling: GETs /jobs/{id}. On `job_state === "stopped"` and
 *      `result.status === "success"`, downloads the MP4, deletes any
 *      prior Descript-published media rows (manual uploads preserved),
 *      inserts a new row at the next free index, mirrors the cover
 *      columns, and stamps `descript_published_at`.
 *
 * Race guard: every polling tick re-reads `descript_publish_job_id` from
 * the row. If it no longer matches our payload's job id (the user clicked
 * "Sync from Descript" mid-poll and a fresh job kicked off), we bail —
 * the new task instance owns the item.
 */
export const descriptPublishAndArchiveTask: Task = async (
  rawPayload,
  helpers,
) => {
  const payload = rawPayload as DescriptPublishAndArchivePayload;

  const [item] = await db
    .select({
      id: productionItems.id,
      descriptProjectId: productionItems.descriptProjectId,
      descriptCompositionId: productionItems.descriptCompositionId,
      descriptPublishJobId: productionItems.descriptPublishJobId,
      descriptPublishedAt: productionItems.descriptPublishedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, payload.productionItemId))
    .limit(1);

  if (!item) {
    helpers.logger.warn(
      `descript-publish-and-archive: item ${payload.productionItemId} not found`,
    );
    return;
  }
  if (!item.descriptProjectId || !item.descriptCompositionId) {
    // Shouldn't happen — auto-chain only fires after composition is stamped.
    // But defense in depth: if the resolve task hasn't completed yet, bail
    // and let it re-fire us when it does.
    helpers.logger.warn(
      `descript-publish-and-archive: item ${item.id} has no project/composition; skipping`,
    );
    return;
  }

  // -- Phase 1: kick off the publish job --
  if (!payload.publishJobId) {
    if (item.descriptPublishedAt && !payload.force) {
      helpers.logger.info(
        `descript-publish-and-archive: item ${item.id} already rendered; skipping (use force to re-publish)`,
      );
      return;
    }

    const { jobId } = await publishDescriptComposition({
      projectId: item.descriptProjectId,
      compositionId: item.descriptCompositionId,
      resolution: "1080p",
      accessLevel: "unlisted",
    });
    await db
      .update(productionItems)
      .set({
        descriptPublishJobId: jobId,
        descriptPublishError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, item.id));

    helpers.logger.info(
      `descript-publish-and-archive: kicked off job=${jobId} for item=${item.id}`,
    );
    await helpers.addJob(
      "descript-publish-and-archive",
      {
        productionItemId: item.id,
        publishJobId: jobId,
        deadlineAt: Date.now() + DEADLINE_MS,
        force: payload.force,
      },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    return;
  }

  // -- Phase 2: poll the publish job --

  // Race guard: if the canonical job_id changed under us (manual sync
  // restarted), bail. The new task instance owns the item.
  if (item.descriptPublishJobId !== payload.publishJobId) {
    helpers.logger.info(
      `descript-publish-and-archive: stale poll for item=${item.id} (payload jobId=${payload.publishJobId}, item jobId=${item.descriptPublishJobId ?? "null"}) — bailing`,
    );
    return;
  }

  const job = await fetchDescriptJob(payload.publishJobId);

  if (job.job_state !== "stopped") {
    // Still running. Keep polling until deadline.
    if (Date.now() >= (payload.deadlineAt ?? 0)) {
      const msg = `Descript publish job ${payload.publishJobId} did not stop before deadline`;
      await db
        .update(productionItems)
        .set({
          descriptPublishError: msg.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, item.id));
      throw new Error(msg);
    }
    await helpers.addJob(
      "descript-publish-and-archive",
      payload,
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    return;
  }

  // Job stopped. Verify success.
  if (job.result?.status !== "success") {
    const msg = `Descript publish failed: ${job.result?.error_message ?? "no error message"}`;
    await db
      .update(productionItems)
      .set({
        descriptPublishError: msg.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, item.id));
    throw new Error(msg);
  }
  const downloadUrl = job.result?.download_url;
  if (!downloadUrl) {
    const msg =
      "Descript publish succeeded but no download_url in result — cannot archive";
    await db
      .update(productionItems)
      .set({
        descriptPublishError: msg,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, item.id));
    throw new Error(msg);
  }

  // Download the MP4. Outside the transaction because it can take
  // seconds and we don't want to hold a DB connection.
  const archive = await archiveRemoteToS3(
    item.id,
    downloadUrl,
    "descript-rendered.mp4",
  );

  // In one transaction: delete prior Descript-published rows, insert the
  // new row, mirror legacy cover columns, stamp `descript_published_at`.
  await db.transaction(async (tx) => {
    // Delete only previously-Descript-published rows. Manually-uploaded
    // media has a different (or null) `source_url` and is preserved.
    await tx
      .delete(productionItemMedia)
      .where(
        and(
          eq(productionItemMedia.productionItemId, item.id),
          sql`${productionItemMedia.sourceUrl} LIKE ${DESCRIPT_EXPORT_URL_PREFIX + "%"}`,
        ),
      );

    await addMediaRowsToDraft(tx, {
      itemId: item.id,
      files: [
        {
          s3Bucket: bucketName(),
          s3Key: archive.key,
          contentType: archive.contentType,
          sizeBytes: archive.size,
          kind: "video",
          posterS3Key: null,
          sourceUrl: downloadUrl,
        },
      ],
    });

    // Mirror the new index-0 onto legacy single-cover columns so cover
    // thumbnails + content_media_url consumers see the latest. Same
    // pattern the manual-upload route already uses.
    const [lowest] = await tx
      .select({
        s3Bucket: productionItemMedia.s3Bucket,
        s3Key: productionItemMedia.s3Key,
        contentType: productionItemMedia.contentType,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, item.id))
      .orderBy(asc(productionItemMedia.index))
      .limit(1);

    await tx
      .update(productionItems)
      .set({
        mediaS3Bucket: lowest?.s3Bucket ?? null,
        mediaS3Key: lowest?.s3Key ?? null,
        mediaContentType: lowest?.contentType ?? null,
        posterS3Key: lowest?.posterS3Key ?? lowest?.s3Key ?? null,
        descriptPublishedAt: new Date(),
        descriptPublishError: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, item.id));
  });

  helpers.logger.info(
    `descript-publish-and-archive: ok item=${item.id} s3=${archive.key} (${archive.size}B)`,
  );
};
