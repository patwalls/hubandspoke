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
import { bucketName } from "@/lib/s3";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

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
    // Snapshot the rows about to be dropped so we can emit one
    // media_removed event per deleted row to the activity feed (the row
    // is gone after the delete, so we capture s3Key + index here).
    const priorDescriptRows = await tx
      .select({
        id: productionItemMedia.id,
        index: productionItemMedia.index,
        kind: productionItemMedia.kind,
        s3Key: productionItemMedia.s3Key,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(
        and(
          eq(productionItemMedia.productionItemId, item.id),
          sql`${productionItemMedia.sourceUrl} LIKE ${DESCRIPT_EXPORT_URL_PREFIX + "%"}`,
        ),
      );
    await tx
      .delete(productionItemMedia)
      .where(
        and(
          eq(productionItemMedia.productionItemId, item.id),
          sql`${productionItemMedia.sourceUrl} LIKE ${DESCRIPT_EXPORT_URL_PREFIX + "%"}`,
        ),
      );

    // Make room at index 0 by shifting every remaining row up by 1. The
    // rendered clip is the canonical video for a repurposed reel — it has
    // to land at index 0 so the simulator's slides[0] (and the legacy
    // mediaS3Key mirror below, which picks the lowest index) both point at
    // it instead of inherited source media that repost-seed copied in.
    // Two-pass via negative scratch indexes — a direct `SET index = index
    // + 1` collides on (production_item_id, index) mid-update.
    await tx.execute(sql`
      UPDATE production_item_media
         SET index = -(index + 1)
       WHERE production_item_id = ${item.id}
    `);
    await tx.execute(sql`
      UPDATE production_item_media
         SET index = -index
       WHERE production_item_id = ${item.id}
         AND index < 0
    `);

    const insertedRows = await tx
      .insert(productionItemMedia)
      .values({
        productionItemId: item.id,
        index: 0,
        kind: "video",
        s3Bucket: bucketName(),
        s3Key: archive.key,
        contentType: archive.contentType,
        sizeBytes: archive.size,
        posterS3Key: null,
        sourceUrl: downloadUrl,
      })
      .returning();

    // Audit: one media_removed per replaced prior render + one
    // media_added for the freshly archived MP4. Source is the
    // slice-algorithm — the conceptual pipeline that selects, trims, and
    // renders this clip. (Descript is the tool inside that pipeline; its
    // step-by-step events are already captured by the existing
    // `tool_action` variant — composition ready, render started, etc.)
    const sliceChanges: ContentChange[] = [];
    for (const prior of priorDescriptRows) {
      sliceChanges.push({
        target: {
          kind: "media_removed",
          mediaId: prior.id,
          index: prior.index,
          mediaKind: prior.kind as "image" | "video",
          s3Key: prior.s3Key,
          posterS3Key: prior.posterS3Key ?? null,
        },
      });
    }
    for (const inserted of insertedRows) {
      sliceChanges.push({
        target: {
          kind: "media_added",
          mediaId: inserted.id,
          index: inserted.index,
          mediaKind: inserted.kind as "image" | "video",
          s3Key: inserted.s3Key,
          posterS3Key: inserted.posterS3Key ?? null,
        },
      });
    }
    if (sliceChanges.length > 0) {
      await recordContentChanges({
        tx,
        contentItemId: item.id,
        userId: null,
        source: { kind: "algorithm", name: "slice-algorithm" },
        changes: sliceChanges,
      });
    }

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
