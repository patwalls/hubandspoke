import type { Task } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, productionItemMedia } from "@/lib/db/schema";
import { createCanvaExport, fetchCanvaExportJob } from "@/lib/canva";
import { archiveRemoteToS3 } from "@/lib/services/enrichment/shared";
import { bucketName } from "@/lib/s3";
import { recordToolAction } from "@/lib/services/content-events";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

export interface CanvaExportPageVideoPayload {
  productionItemId: string;
  designId: string;
  /** 1-indexed page number to export as MP4. Default 3 — that's where the
   *  Tech Stack Slideshow template carries its video element. Other formats
   *  with video on a different page can override. */
  pageIndex?: number;
  /** Set after the first invocation creates the export job. */
  jobId?: string;
  deadlineAt?: number;
}

// MP4 exports of a single page are typically <30s but Canva can take
// longer on first export. 8 minute cliff is generous; failures past that
// surface in canva_video_export_error.
const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 8 * 60 * 1000;

/**
 * Export a single Canva page as MP4 and replace the matching PNG row in
 * `production_item_media` with a video-kind row, so the IG-Post simulator
 * renders a playable `<video>` at the carousel slot where the video lives.
 * Best-effort: a Canva error here doesn't unwind the rest of the
 * autofill pipeline — it just stamps `canva_video_export_error` and the
 * carousel keeps showing the PNG.
 *
 * Why a separate task instead of folding into canva-export-design? PNG
 * and MP4 exports are different jobs with different runtimes (MP4 takes
 * 5-10x longer); chaining keeps each task's deadline tight and lets
 * graphile-worker retry one without redoing the other.
 */
export const canvaExportPageVideoTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as CanvaExportPageVideoPayload;
  const pageIndex = payload.pageIndex ?? 3;
  const targetMediaIndex = pageIndex - 1; // 1-indexed → 0-indexed
  const deadlineAt = payload.deadlineAt ?? Date.now() + DEADLINE_MS;

  if (!payload.jobId) {
    const { jobId } = await createCanvaExport({
      designId: payload.designId,
      type: "mp4",
      pages: [pageIndex],
    });
    await db
      .update(productionItems)
      .set({
        canvaVideoExportJobId: jobId,
        canvaVideoExportError: null,
      })
      .where(eq(productionItems.id, payload.productionItemId));
    await helpers.addJob(
      "canva-export-page-video",
      { ...payload, jobId, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    helpers.logger.info(
      `canva-export-page-video created job ${jobId} page=${pageIndex} for item ${payload.productionItemId}`,
    );
    return;
  }

  const result = await fetchCanvaExportJob(payload.jobId);
  if (result.status === "success") {
    const url = result.urls?.[0];
    if (!url) {
      throw new Error(
        `Canva mp4 export ${payload.jobId} succeeded with no url`,
      );
    }
    // Archive the MP4 into our S3 bucket so we own the URL forever (Canva's
    // export URL is signed and expires).
    const archived = await archiveRemoteToS3(
      payload.productionItemId,
      url,
      `canva-page-${pageIndex}-video.mp4`,
    );

    // Preserve the existing PNG row's s3 key as the video's poster — gives
    // the carousel a real thumbnail while the video metadata loads, and
    // also gives the editor a frame fallback if the playback fails.
    const [existing] = await db
      .select({
        id: productionItemMedia.id,
        s3Key: productionItemMedia.s3Key,
        kind: productionItemMedia.kind,
        posterS3Key: productionItemMedia.posterS3Key,
      })
      .from(productionItemMedia)
      .where(
        and(
          eq(productionItemMedia.productionItemId, payload.productionItemId),
          eq(productionItemMedia.index, targetMediaIndex),
        ),
      )
      .limit(1);
    const posterS3Key = existing?.s3Key ?? null;

    // Replace the existing media row at this index with the video version.
    // archiveCarouselMedia keyed off (productionItemId, index) earlier, so
    // a row already exists for index=targetMediaIndex; flip kind to video
    // + swap the s3 key. The carousel auto-renders <video> for kind=video.
    const row = {
      productionItemId: payload.productionItemId,
      index: targetMediaIndex,
      kind: "video" as const,
      s3Bucket: bucketName(),
      s3Key: archived.key,
      contentType: archived.contentType,
      sizeBytes: archived.size,
      posterS3Key,
      sourceUrl: url,
      uploadedAt: new Date(),
    };
    let mediaRowId: string;
    if (existing) {
      const [updated] = await db
        .update(productionItemMedia)
        .set(row)
        .where(
          and(
            eq(productionItemMedia.productionItemId, payload.productionItemId),
            eq(productionItemMedia.index, targetMediaIndex),
          ),
        )
        .returning({ id: productionItemMedia.id });
      mediaRowId = updated.id;
    } else {
      const [inserted] = await db
        .insert(productionItemMedia)
        .values(row)
        .returning({ id: productionItemMedia.id });
      mediaRowId = inserted.id;
    }

    // Audit trail: removed the PNG snapshot, added the MP4. Both events
    // share the (item, index) so the activity feed renders the swap as
    // two adjacent rows with thumbnails. Skip the removed event when
    // there was no prior row (first run of a never-archived item).
    const mediaChanges: ContentChange[] = [];
    if (existing) {
      mediaChanges.push({
        target: {
          kind: "media_removed",
          mediaId: existing.id,
          index: targetMediaIndex,
          mediaKind: existing.kind as "image" | "video",
          s3Key: existing.s3Key,
          posterS3Key: existing.posterS3Key ?? null,
        },
      });
    }
    mediaChanges.push({
      target: {
        kind: "media_added",
        mediaId: mediaRowId,
        index: targetMediaIndex,
        mediaKind: "video",
        s3Key: archived.key,
        posterS3Key,
      },
    });
    await recordContentChanges({
      tx: db,
      contentItemId: payload.productionItemId,
      userId: null,
      source: { kind: "tool", tool: "canva" },
      changes: mediaChanges,
    });

    await db
      .update(productionItems)
      .set({
        canvaVideoExportJobId: null,
        canvaVideoExportedAt: new Date(),
        canvaVideoExportError: null,
      })
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
      action: "page_video_exported",
      status: "success",
      label: `Page ${pageIndex} video loaded from Canva`,
      url: null,
      meta: { designId: payload.designId, pageIndex, bytes: archived.size },
    });

    helpers.logger.info(
      `canva-export-page-video ok item=${payload.productionItemId} page=${pageIndex} bytes=${archived.size}`,
    );
    return;
  }

  if (result.status === "failed") {
    const errMsg = result.errorMessage ?? "unknown";
    await db
      .update(productionItems)
      .set({
        canvaVideoExportJobId: null,
        canvaVideoExportError: errMsg.slice(0, 1000),
      })
      .where(eq(productionItems.id, payload.productionItemId));
    throw new Error(
      `Canva mp4 export ${payload.jobId} failed: ${errMsg}`,
    );
  }

  if (Date.now() >= deadlineAt) {
    throw new Error(
      `Canva mp4 export ${payload.jobId} did not finish before deadline`,
    );
  }
  await helpers.addJob(
    "canva-export-page-video",
    { ...payload, deadlineAt },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
};
