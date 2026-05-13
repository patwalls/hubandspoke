import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  createCanvaExport,
  fetchCanvaExportJob,
} from "@/lib/canva";
import { archiveCarouselMedia } from "@/lib/services/enrichment/shared";
import { recordToolAction } from "@/lib/services/content-events";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

export interface CanvaExportDesignPayload {
  productionItemId: string;
  designId: string;
  /** Set after the first invocation creates the export job. */
  jobId?: string;
  /** Epoch ms. Set on the first invocation; carried forward across re-enqueues. */
  deadlineAt?: number;
}

// Canva PNG exports of a small (4-page) slideshow typically settle in
// 10-30 seconds. 5 minute cliff is generous and surfaces a stuck export
// as a worker failure rather than silent churn.
const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 5 * 60 * 1000;

/**
 * Export every page of a Canva design as PNG, archive each into S3, and
 * insert one `production_item_media` row per page so the IG-Post carousel
 * simulator on the detail page renders the slides as they appear in Canva.
 *
 * Two phases compressed into one task:
 *   1. First invocation (no jobId): POST /v1/exports for design_id with
 *      type=png. Saves the returned job id on the productionItem and
 *      re-enqueues with `jobId` set + 5s delay.
 *   2. Subsequent invocations: GET /v1/exports/{jobId}. On success Canva
 *      returns one URL per page; we hand them to `archiveCarouselMedia`
 *      which downloads each, uploads to S3, and upserts a
 *      `production_item_media` row keyed by (productionItemId, index).
 *      Cover columns are mirrored to the legacy `media_s3_*` columns so
 *      list-view queries don't need a join. Stamps `canva_exported_at`
 *      and clears `canva_export_job_id` on success.
 *
 * Auto-chained from `canva-create-copy` after autofill succeeds. Can be
 * re-triggered manually (planned UI: "Re-sync from Canva" button) when
 * the editor edits the design in Canva and wants fresh slides.
 */
export const canvaExportDesignTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as CanvaExportDesignPayload;
  const deadlineAt = payload.deadlineAt ?? Date.now() + DEADLINE_MS;

  // First phase: kick off the export job.
  if (!payload.jobId) {
    const { jobId } = await createCanvaExport({
      designId: payload.designId,
      type: "png",
    });
    await db
      .update(productionItems)
      .set({
        canvaExportJobId: jobId,
        canvaExportError: null,
      })
      .where(eq(productionItems.id, payload.productionItemId));
    await helpers.addJob(
      "canva-export-design",
      { ...payload, jobId, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    helpers.logger.info(
      `canva-export-design created job ${jobId} for item ${payload.productionItemId}`,
    );
    return;
  }

  // Second phase: poll.
  const result = await fetchCanvaExportJob(payload.jobId);
  if (result.status === "success") {
    const urls = result.urls ?? [];
    if (urls.length === 0) {
      throw new Error(
        `Canva export job ${payload.jobId} succeeded but returned 0 urls`,
      );
    }
    const slides = urls.map((url, i) => ({
      url,
      kind: "image" as const,
      fileNameHint: `canva-slide-${i + 1}`,
    }));
    const archive = await archiveCarouselMedia(
      payload.productionItemId,
      slides,
    );

    // Mirror the index-0 cover into the legacy media_* columns on
    // productionItems — same invariant the manual-upload, Descript, and
    // enrichment paths follow. Without this the queue/list views miss the
    // poster on the cover card. Type is image/png from Canva.
    const setFields: Record<string, unknown> = {
      canvaExportJobId: null,
      canvaExportedAt: new Date(),
      canvaExportError: null,
    };
    if (archive.primary) {
      setFields.mediaS3Key = archive.primary.key;
      setFields.mediaContentType = archive.primary.contentType;
      setFields.mediaSizeBytes = archive.primary.size;
      setFields.mediaS3UploadedAt = new Date();
    }
    await db
      .update(productionItems)
      .set(setFields)
      .where(eq(productionItems.id, payload.productionItemId));

    const [item] = await db
      .select({ editorUserId: productionItems.editorUserId })
      .from(productionItems)
      .where(eq(productionItems.id, payload.productionItemId))
      .limit(1);
    await recordToolAction({
      contentItemId: payload.productionItemId,
      userId: item?.editorUserId ?? null,
      tool: "canva",
      action: "design_exported",
      status: "success",
      label: `${archive.archived} slide${archive.archived === 1 ? "" : "s"} loaded from Canva`,
      url: null,
      meta: {
        designId: payload.designId,
        pages: archive.total,
        archived: archive.archived,
      },
    });

    // One `content_changed` event per slide the helper inserted or
    // replaced, sourced as the Canva tool integration. Surfaces in the
    // activity feed as "Canva added slide 1, slide 2, …" with a thumbnail
    // per row. archiveCarouselMedia is idempotent so re-runs (e.g. editor
    // re-triggers export after tweaking the design) emit only the slides
    // whose sourceUrl actually moved.
    if (archive.affected.length > 0) {
      const mediaChanges: ContentChange[] = archive.affected.map((slide) => ({
        target: {
          kind: "media_added",
          mediaId: slide.mediaId,
          index: slide.index,
          mediaKind: slide.kind,
          s3Key: slide.s3Key,
          posterS3Key: slide.posterS3Key,
        },
      }));
      await recordContentChanges({
        tx: db,
        contentItemId: payload.productionItemId,
        userId: null,
        source: { kind: "tool", tool: "canva" },
        changes: mediaChanges,
      });
    }

    helpers.logger.info(
      `canva-export-design ok item=${payload.productionItemId} design=${payload.designId} archived=${archive.archived}/${archive.total}`,
    );

    // Auto-chain: kick off an MP4 export of the video-bearing page so the
    // carousel can render a real <video> at that slot instead of a static
    // PNG snapshot of the video element. Fire-and-forget — best-effort,
    // failure here doesn't unwind the PNG archive above.
    try {
      await helpers.addJob("canva-export-page-video", {
        productionItemId: payload.productionItemId,
        designId: payload.designId,
      });
    } catch (err) {
      helpers.logger.warn(
        `canva-export-design: failed to enqueue canva-export-page-video for item ${payload.productionItemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (result.status === "failed") {
    const errMsg = result.errorMessage ?? "unknown";
    await db
      .update(productionItems)
      .set({
        canvaExportJobId: null,
        canvaExportError: errMsg.slice(0, 1000),
      })
      .where(eq(productionItems.id, payload.productionItemId));
    throw new Error(
      `Canva export job ${payload.jobId} failed: ${errMsg}`,
    );
  }

  // In-progress: re-enqueue if still inside the deadline; otherwise blow up.
  if (Date.now() >= deadlineAt) {
    throw new Error(
      `Canva export job ${payload.jobId} did not finish before deadline`,
    );
  }
  await helpers.addJob(
    "canva-export-design",
    { ...payload, deadlineAt },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
};
