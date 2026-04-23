import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { pipeline } from "stream/promises";
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
  createDescriptProjectWithUpload,
  fetchDescriptJob,
} from "@/lib/descript";
import { getPresignedGetUrl } from "@/lib/s3";

export interface ClipIdeaPreciseCutPayload {
  clipIdeaId: string;
  triggerId: string;
  derivativeItemId: string;
  /** Set once the upload has been handed to Descript; subsequent runs only poll. */
  uploadJobId?: string;
  /** Epoch ms. Set on the first poll; carried forward across re-enqueues. */
  deadlineAt?: number;
}

const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 30 * 60 * 1000;

/**
 * Precise-cut flow, split across two phases so each task invocation stays
 * short enough to survive a deploy:
 *
 *   1. First run (no uploadJobId in payload): download from S3, ffmpeg-trim,
 *      create a Descript project + signed upload URL, PUT the bytes, then
 *      enqueue a continuation carrying the Descript upload jobId.
 *   2. Continuation runs: one poll per invocation. If the import job is
 *      stopped, persist descriptCompositionId on the trigger + derivative.
 *      Otherwise self-re-enqueue with a 5s delay.
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

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`S3 download failed: HTTP ${res.status}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as NodeReadableStream),
    createWriteStream(destPath),
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

async function putFileToUrl(
  filePath: string,
  url: string,
  contentType: string,
  contentLength: number,
): Promise<void> {
  const stream = createReadStream(filePath);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    },
    body: stream as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Descript upload PUT failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Missing tempfile on cleanup is fine — nothing to do.
  }
}
