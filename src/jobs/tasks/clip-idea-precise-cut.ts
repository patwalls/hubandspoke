import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { db } from "@/lib/db";
import {
  clipIdeas,
  productionItems,
  repurposeTriggers,
} from "@/lib/db/schema";
import {
  buildLayoutPackPrompt,
  createDescriptProjectWithUpload,
  fetchDescriptJob,
  getDescriptLayoutPackName,
  invokeDescriptAgent,
} from "@/lib/descript";
import { getPresignedGetUrl } from "@/lib/s3";
import {
  downloadToFile,
  putFileToUrl,
  safeUnlink,
} from "./descript-upload-helpers";

export interface ClipIdeaPreciseCutPayload {
  clipIdeaId: string;
  triggerId: string;
  derivativeItemId: string;
  /** Set once the upload has been handed to Descript; subsequent runs only poll. */
  uploadJobId?: string;
  /** Set after the import finishes when the user opted into the AI layout
   *  pack and the Underlord agent has been invoked to apply the configured
   *  pack to the just-imported composition. Subsequent runs poll this job
   *  until it stops (status updates only — composition_id was already
   *  persisted from the import phase). */
  layoutJobId?: string;
  /** When true, after the import finishes invoke the Underlord agent to
   *  apply `DESCRIPT_LAYOUT_PACK_NAME` to the composition (ignores fillers
   *  too). Set per-promotion by the route based on the user's button choice
   *  ("Precise cut + Underlord" vs "Precise cut — no AI"). Undefined/false
   *  on existing in-flight payloads keeps them on the no-AI path. */
  applyLayoutPack?: boolean;
  /** Epoch ms. Set on the first poll; carried forward across re-enqueues. */
  deadlineAt?: number;
}

const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 30 * 60 * 1000;

/**
 * Precise-cut flow, split across phases so each task invocation stays short
 * enough to survive a deploy:
 *
 *   1. First run (no uploadJobId, no layoutJobId): download from S3,
 *      ffmpeg-trim, create a Descript project + signed upload URL, PUT the
 *      bytes, then enqueue a continuation carrying the Descript upload jobId.
 *   2. Upload-poll phase (uploadJobId set): one poll per invocation. When
 *      the import job stops, persist descriptCompositionId on the trigger +
 *      derivative. If `DESCRIPT_LAYOUT_PACK_NAME` is enabled, kick off an
 *      Underlord agent call to apply the layout pack to the just-imported
 *      composition and re-enqueue with `layoutJobId`. Otherwise we're done.
 *   3. Layout-poll phase (layoutJobId set): one poll per invocation. The
 *      Underlord call mutates the composition in place — composition_id
 *      doesn't change, so this phase is purely status-watching for retries
 *      and observability. Logs and exits when the agent job stops.
 *
 * Idempotency: the derivative production_item is uniq-constrained on
 * source_clip_idea_id, so a retry after a partial failure re-finds the same
 * derivative row and updates it. The Descript side may create a duplicate
 * project if phase 1 is retried after a partial failure — acceptable since
 * retries should be rare.
 */
export const clipIdeaPreciseCutTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as ClipIdeaPreciseCutPayload;
  const { clipIdeaId, triggerId, derivativeItemId } = payload;
  const deadlineAt = payload.deadlineAt ?? Date.now() + DEADLINE_MS;

  if (payload.layoutJobId) {
    await pollLayoutOnce(helpers, payload, deadlineAt);
    return;
  }
  if (payload.uploadJobId) {
    await pollUploadOnce(helpers, payload, deadlineAt);
    return;
  }

  const [row] = await db
    .select({
      hook: clipIdeas.hook,
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      mediaS3Key: productionItems.mediaS3Key,
      mediaContentType: productionItems.mediaContentType,
    })
    .from(clipIdeas)
    .leftJoin(
      productionItems,
      eq(productionItems.id, clipIdeas.sourceProductionItemId),
    )
    .where(eq(clipIdeas.id, clipIdeaId))
    .limit(1);
  if (!row) throw new Error(`clip idea ${clipIdeaId} not found`);
  if (!row.mediaS3Key) {
    throw new Error(
      `source production_item has no mediaS3Key — cannot cut locally`,
    );
  }

  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  if (!(endSec > startSec)) {
    throw new Error(`invalid range: startSec=${startSec} endSec=${endSec}`);
  }

  const jobDir = tmpdir();
  const runId = randomUUID();
  const sourcePath = join(jobDir, `clip-src-${runId}.mp4`);
  const clipPath = join(jobDir, `clip-out-${runId}.mp4`);

  try {
    helpers.logger.info(
      `precise-cut start clip=${clipIdeaId} range=${startSec}-${endSec}`,
    );

    const getUrl = await getPresignedGetUrl(row.mediaS3Key, 3600);
    await downloadToFile(getUrl, sourcePath);

    await ffmpegTrim({
      ffmpegPath: ffmpegInstaller.path,
      inputPath: sourcePath,
      outputPath: clipPath,
      startSec,
      endSec,
      logger: helpers.logger,
    });

    const clipStat = await stat(clipPath);
    const uploadContentType = row.mediaContentType || "video/mp4";

    const upload = await createDescriptProjectWithUpload({
      projectName: row.hook,
      contentType: uploadContentType,
      fileSize: clipStat.size,
    });
    helpers.logger.info(
      `precise-cut upload_url ready clip=${clipIdeaId} job=${upload.jobId} bytes=${clipStat.size}`,
    );

    await putFileToUrl(clipPath, upload.uploadUrl, uploadContentType, clipStat.size);

    await db
      .update(repurposeTriggers)
      .set({
        descriptJobId: upload.jobId,
        descriptProjectUrl: upload.projectUrl,
      })
      .where(eq(repurposeTriggers.id, triggerId));
    await db
      .update(productionItems)
      .set({
        descriptProjectId: upload.projectId,
        descriptProjectUrl: upload.projectUrl,
      })
      .where(eq(productionItems.id, derivativeItemId));

    await helpers.addJob(
      "clip-idea-precise-cut",
      { ...payload, uploadJobId: upload.jobId, deadlineAt },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
  } finally {
    await safeUnlink(sourcePath);
    await safeUnlink(clipPath);
  }
};

async function pollUploadOnce(
  helpers: Parameters<Task>[1],
  payload: ClipIdeaPreciseCutPayload,
  deadlineAt: number,
): Promise<void> {
  const uploadJobId = payload.uploadJobId!;
  const job = await fetchDescriptJob(uploadJobId);
  if (job.job_state === "stopped") {
    // Import creates exactly one composition (the one we declared in
    // add_compositions). Persist its id so the UI can exit "Clip
    // processing…" and deep-link into the composition.
    const compositionId = job.result?.created_compositions?.[0]?.id;
    if (compositionId) {
      await db
        .update(repurposeTriggers)
        .set({ descriptCompositionId: compositionId })
        .where(eq(repurposeTriggers.id, payload.triggerId));
      await db
        .update(productionItems)
        .set({ descriptCompositionId: compositionId })
        .where(eq(productionItems.id, payload.derivativeItemId));
    }
    helpers.logger.info(
      `precise-cut ok clip=${payload.clipIdeaId} composition=${compositionId ?? "none"}`,
    );

    // Layout-pack phase: ask Underlord to apply the configured layout pack
    // to the just-imported composition. Requires both the per-promotion
    // opt-in flag (set by the "Precise cut + Underlord" button) AND a
    // configured pack name in env. Skipped silently when either is missing,
    // or when we somehow lost the compositionId. The project_id was stamped
    // on the derivative production_item in phase 1.
    const layoutPackName = getDescriptLayoutPackName();
    if (!payload.applyLayoutPack || !compositionId || !layoutPackName) {
      return;
    }

    const [derivative] = await db
      .select({ descriptProjectId: productionItems.descriptProjectId })
      .from(productionItems)
      .where(eq(productionItems.id, payload.derivativeItemId))
      .limit(1);
    if (!derivative?.descriptProjectId) {
      helpers.logger.info(
        `precise-cut layout-skip clip=${payload.clipIdeaId} reason=no_project_id`,
      );
      return;
    }

    const prompt = buildLayoutPackPrompt({
      compositionId,
      layoutPackName,
    });
    const agent = await invokeDescriptAgent({
      projectId: derivative.descriptProjectId,
      prompt,
    });
    await db
      .update(repurposeTriggers)
      .set({ descriptPrompt: prompt })
      .where(eq(repurposeTriggers.id, payload.triggerId));
    helpers.logger.info(
      `precise-cut layout-start clip=${payload.clipIdeaId} pack="${layoutPackName}" job=${agent.jobId}`,
    );

    await helpers.addJob(
      "clip-idea-precise-cut",
      {
        ...payload,
        layoutJobId: agent.jobId,
        deadlineAt: Date.now() + DEADLINE_MS,
      },
      { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
    );
    return;
  }

  if (Date.now() >= deadlineAt) {
    throw new Error(
      `Descript import ${uploadJobId} did not stop before deadline`,
    );
  }

  await helpers.addJob(
    "clip-idea-precise-cut",
    { ...payload, deadlineAt },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
}

async function pollLayoutOnce(
  helpers: Parameters<Task>[1],
  payload: ClipIdeaPreciseCutPayload,
  deadlineAt: number,
): Promise<void> {
  const layoutJobId = payload.layoutJobId!;
  const job = await fetchDescriptJob(layoutJobId);
  if (job.job_state === "stopped") {
    // Layout-apply mutates the composition in place. compositionId is
    // unchanged from the import phase, so nothing to persist — just log.
    helpers.logger.info(
      `precise-cut layout-ok clip=${payload.clipIdeaId} job=${layoutJobId}`,
    );
    return;
  }

  if (Date.now() >= deadlineAt) {
    throw new Error(
      `Descript layout-apply ${layoutJobId} did not stop before deadline`,
    );
  }

  await helpers.addJob(
    "clip-idea-precise-cut",
    { ...payload, deadlineAt },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
}

async function ffmpegTrim(args: {
  ffmpegPath: string;
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  const tryRun = (useStreamCopy: boolean) =>
    new Promise<void>((resolve, reject) => {
      const codecArgs = useStreamCopy
        ? ["-c", "copy"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"];
      const ffArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(args.startSec),
        "-to",
        String(args.endSec),
        "-i",
        args.inputPath,
        ...codecArgs,
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        args.outputPath,
      ];
      const proc = spawn(args.ffmpegPath, ffArgs, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (b) => {
        stderr += b.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ffmpeg exited ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
            ),
          );
      });
    });

  try {
    await tryRun(true);
    args.logger.info("ffmpeg stream-copy ok");
  } catch (err) {
    args.logger.info(
      `ffmpeg stream-copy failed, falling back to re-encode: ${(err as Error).message}`,
    );
    await tryRun(false);
    args.logger.info("ffmpeg re-encode ok");
  }
}

