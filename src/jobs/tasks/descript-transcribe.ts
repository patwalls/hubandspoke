import { randomUUID } from "crypto";
import { stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import {
  createDescriptProjectWithUpload,
  fetchDescriptJob,
  publishComposition,
} from "@/lib/descript";
import {
  pollPublishJobOnce,
  saveDescriptTranscriptFromShareUrl,
  TranscriptFetchError,
} from "@/lib/services/transcript-fetch";
import { getPresignedGetUrl } from "@/lib/s3";
import {
  downloadToFile,
  putFileToUrl,
  safeUnlink,
} from "./descript-upload-helpers";

export interface DescriptTranscribePayload {
  productionItemId: string;
  /** Set once the S3 media has been handed to Descript. */
  uploadJobId?: string;
  /** Set once the import job stopped and we pulled the composition id. */
  compositionId?: string;
  /** Set once we've kicked off the publish job. */
  publishJobId?: string;
  /** Epoch ms; carried forward across re-enqueues. */
  deadlineAt?: number;
}

const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 30 * 60 * 1000;

/**
 * Transcribe an item's archived media via Descript end-to-end: upload the
 * S3 bytes, wait for the import job, publish the resulting composition,
 * wait for the publish job, parse the returned WEBVTT subtitles, and upsert
 * a `transcripts` row with `source='descript'`.
 *
 * Used as the default "how do we get a transcript for this video" path when
 * the media is archived but the platform's own transcript source is missing
 * (IG reels >2 min, YouTube videos without captions, direct uploads).
 *
 * Short-invocation / self-re-enqueue pattern: each invocation does one HTTP
 * poll and hands off to a successor run with a 5s delay, so a deploy
 * SIGTERM mid-poll never leaks a lock on a multi-minute job.
 *
 * Phase is decided by which fields are populated on the payload:
 *   1. No uploadJobId                 → download S3, create project, PUT bytes
 *   2. uploadJobId, no compositionId  → poll import job, save composition id
 *   3. compositionId, no publishJobId → call publishComposition()
 *   4. publishJobId                   → poll publish job, parse VTT, save
 *
 * Gated by DESCRIPT_TRANSCRIPT_FETCH_LIVE at the enqueue site, not here —
 * once a job is in the queue we want to let it complete even if the flag
 * flips off mid-run.
 */
export const descriptTranscribeTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as DescriptTranscribePayload;
  const { productionItemId } = payload;
  const deadlineAt = payload.deadlineAt ?? Date.now() + DEADLINE_MS;

  // If anything else (SC, a manual sync, a prior run) already filled in a
  // transcript, stop — don't pay Descript again to produce a duplicate.
  const [existing] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);
  if (existing) {
    helpers.logger.info(
      `descript-transcribe skip item=${productionItemId} — transcript already exists`,
    );
    return;
  }

  // Phase 4: publish job is in-flight.
  if (payload.publishJobId) {
    const poll = await pollPublishJobOnce(payload.publishJobId);
    if (poll.kind === "stopped") {
      const result = await saveDescriptTranscriptFromShareUrl(
        productionItemId,
        poll.shareUrl,
      );
      helpers.logger.info(
        `descript-transcribe ok item=${productionItemId} segments=${result.segmentCount} words=${result.wordCount}`,
      );
      return;
    }
    if (Date.now() >= deadlineAt) {
      throw new TranscriptFetchError(
        `Publish job ${payload.publishJobId} did not stop before deadline`,
        "publish_timeout",
      );
    }
    await helpers.addJob(
      "descript-transcribe",
      { ...payload, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    return;
  }

  // Phase 3: composition ready; kick off publish.
  if (payload.compositionId) {
    const [item] = await db
      .select({ descriptProjectId: productionItems.descriptProjectId })
      .from(productionItems)
      .where(eq(productionItems.id, productionItemId))
      .limit(1);
    if (!item?.descriptProjectId) {
      throw new Error(
        `production_item ${productionItemId} lost descriptProjectId between phases`,
      );
    }
    const publish = await publishComposition({
      projectId: item.descriptProjectId,
      compositionId: payload.compositionId,
    });
    helpers.logger.info(
      `descript-transcribe publish started item=${productionItemId} job=${publish.jobId}`,
    );
    await helpers.addJob(
      "descript-transcribe",
      { ...payload, publishJobId: publish.jobId, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    return;
  }

  // Phase 2: import job is in-flight.
  if (payload.uploadJobId) {
    const job = await fetchDescriptJob(payload.uploadJobId);
    if (job.job_state === "stopped") {
      const compositionId = job.result?.created_compositions?.[0]?.id;
      if (!compositionId) {
        throw new Error(
          `Descript import ${payload.uploadJobId} finished without a composition id`,
        );
      }
      await db
        .update(productionItems)
        .set({ descriptCompositionId: compositionId })
        .where(eq(productionItems.id, productionItemId));
      helpers.logger.info(
        `descript-transcribe import stopped item=${productionItemId} composition=${compositionId}`,
      );
      await helpers.addJob(
        "descript-transcribe",
        { ...payload, compositionId, deadlineAt },
        { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
      );
      return;
    }
    if (Date.now() >= deadlineAt) {
      throw new Error(
        `Descript import ${payload.uploadJobId} did not stop before deadline`,
      );
    }
    await helpers.addJob(
      "descript-transcribe",
      { ...payload, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    return;
  }

  // Phase 1: upload S3 bytes to a new Descript project.
  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      mediaS3Key: productionItems.mediaS3Key,
      mediaContentType: productionItems.mediaContentType,
      descriptProjectId: productionItems.descriptProjectId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) {
    throw new Error(`production_item ${productionItemId} not found`);
  }
  if (!item.mediaS3Key) {
    throw new Error(
      `production_item ${productionItemId} has no mediaS3Key — cannot transcribe`,
    );
  }
  if (item.descriptProjectId) {
    // Something already set this — precise-cut, clip-out, or a prior partial
    // transcribe run. Bail loudly rather than silently create a duplicate
    // project. The enqueue helper gates on this too, so reaching here means
    // the item's state changed between enqueue and run.
    throw new Error(
      `production_item ${productionItemId} already has descriptProjectId ${item.descriptProjectId} — refusing to create a duplicate project`,
    );
  }

  const jobDir = tmpdir();
  const runId = randomUUID();
  const sourcePath = join(jobDir, `transcribe-src-${runId}`);
  try {
    helpers.logger.info(
      `descript-transcribe upload start item=${productionItemId} key=${item.mediaS3Key}`,
    );
    const getUrl = await getPresignedGetUrl(item.mediaS3Key, 3600);
    await downloadToFile(getUrl, sourcePath);

    const fileStat = await stat(sourcePath);
    const contentType = item.mediaContentType || "video/mp4";
    const projectName = (item.title || productionItemId).slice(0, 120);

    const upload = await createDescriptProjectWithUpload({
      projectName,
      contentType,
      fileSize: fileStat.size,
    });
    helpers.logger.info(
      `descript-transcribe upload_url ready item=${productionItemId} job=${upload.jobId} bytes=${fileStat.size}`,
    );

    await putFileToUrl(sourcePath, upload.uploadUrl, contentType, fileStat.size);

    await db
      .update(productionItems)
      .set({
        descriptProjectId: upload.projectId,
        descriptProjectUrl: upload.projectUrl,
      })
      .where(eq(productionItems.id, productionItemId));

    await helpers.addJob(
      "descript-transcribe",
      { ...payload, uploadJobId: upload.jobId, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
  } finally {
    await safeUnlink(sourcePath);
  }
};
