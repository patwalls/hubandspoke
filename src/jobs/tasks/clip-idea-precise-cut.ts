import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { db } from "@/lib/db";
import {
  clipIdeas,
  formats,
  productionItems,
  repurposeTriggers,
} from "@/lib/db/schema";
import {
  buildDescriptCompositionUrl,
  buildLayoutPackPrompt,
  createDescriptProjectFromUrl,
  fetchDescriptJob,
  invokeDescriptAgent,
} from "@/lib/descript";
import { getPresignedGetUrl, putObjectFromFile } from "@/lib/s3";
import { recordToolAction } from "@/lib/services/content-events";
import {
  assertCompositionUnique,
  buildCompositionName,
} from "@/lib/services/descript-composition";
import { resolveClipAspectRatio } from "@/lib/db/formats";
import { downloadToFile, safeUnlink } from "./descript-upload-helpers";

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
 * Settle delay between the Underlord agent job stopping and kicking off
 * the MP4 publish. Descript marks the agent job `stopped` as soon as it
 * has parsed and dispatched the layout-pack instructions, but the
 * actual composition mutations (caption track, frame layout, filler
 * trims) can still be writing for a few seconds after that. Publishing
 * immediately renders a slightly-stale MP4 that misses the layout pack.
 *
 * Override via `DESCRIPT_UNDERLORD_SETTLE_MS` if Descript ever changes
 * its consistency model — 60s is the conservative default Pat asked
 * for after observing pre-Underlord MP4s landing in the simulator.
 */
const UNDERLORD_SETTLE_MS = Number(
  process.env.DESCRIPT_UNDERLORD_SETTLE_MS ?? "60000",
);

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

    const uploadContentType = row.mediaContentType || "video/mp4";

    // Upload the trimmed file to a temp S3 location, then ask Descript to
    // pull it via presigned URL. Why not use Descript's signed-PUT flow
    // (POST /jobs/import/project_media → returns upload_url → we PUT bytes)?
    // Because that path is broken on Descript's side (verified 2026-05-05
    // with a synthetic 6 MB test pattern that imports fine via URL-fetch
    // but errors with "Import failed" 1–2s after PUT). The URL-fetch path
    // is also what the cold full-video flow already uses and it's been
    // stable.
    //
    // Tmp S3 prefix is distinct (`clip-tmp/<id>/<uuid>.mp4`) so an S3
    // lifecycle rule can sweep it after 24 h without touching durable
    // pillar uploads. (Lifecycle rule not yet configured — TODO.)
    const tmpPrefix = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads")
      .replace(/\/+$/, "");
    const tmpS3Key = `${tmpPrefix}/clip-tmp/${clipIdeaId}/${randomUUID()}.mp4`;
    helpers.logger.info(
      `precise-cut s3-upload start clip=${clipIdeaId} key=${tmpS3Key}`,
    );
    await putObjectFromFile(tmpS3Key, clipPath, uploadContentType);
    const presignedClipUrl = await getPresignedGetUrl(tmpS3Key, 3600);

    const importRes = await createDescriptProjectFromUrl({
      projectName: buildCompositionName({
        title: row.hook,
        productionItemId: payload.derivativeItemId,
      }),
      mediaUrl: presignedClipUrl,
    });
    helpers.logger.info(
      `precise-cut descript-import enqueued clip=${clipIdeaId} job=${importRes.job_id}`,
    );

    await db
      .update(repurposeTriggers)
      .set({
        descriptJobId: importRes.job_id,
        descriptProjectUrl: importRes.project_url,
      })
      .where(eq(repurposeTriggers.id, triggerId));
    await db
      .update(productionItems)
      .set({
        descriptProjectId: importRes.project_id,
        descriptProjectUrl: importRes.project_url,
      })
      .where(eq(productionItems.id, derivativeItemId));

    await helpers.addJob(
      "clip-idea-precise-cut",
      { ...payload, uploadJobId: importRes.job_id, deadlineAt },
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
    // Descript reports failures as stopped + result.status="error". Without
    // this guard the task would silently succeed (no composition_id ever
    // written) and the UI would hang on "Clip processing…" forever. Throw
    // so graphile-worker retries (transient Descript blips) and surfaces
    // the failure in graphile_worker.jobs.last_error after exhaustion.
    if (job.result?.status === "error") {
      throw new Error(
        `Descript import ${uploadJobId} failed: ${job.result.error_message ?? "no error message"}`,
      );
    }
    // Import creates exactly one composition (the one we declared in
    // add_compositions). Persist its id so the UI can exit "Clip
    // processing…" and deep-link into the composition.
    const compositionId = job.result?.created_compositions?.[0]?.id;
    if (compositionId) {
      await assertCompositionUnique({
        compositionId,
        intendedItemId: payload.derivativeItemId,
      });
      await db
        .update(repurposeTriggers)
        .set({ descriptCompositionId: compositionId })
        .where(eq(repurposeTriggers.id, payload.triggerId));
      await db
        .update(productionItems)
        .set({ descriptCompositionId: compositionId })
        .where(eq(productionItems.id, payload.derivativeItemId));

      // Surface the completion in the activity feed. Read editor +
      // project_id off the derivative; descriptProjectId was set in
      // phase 1 (createDescriptProjectFromUrl), editorUserId at
      // promotion time.
      const [derivative] = await db
        .select({
          editorUserId: productionItems.editorUserId,
          descriptProjectId: productionItems.descriptProjectId,
        })
        .from(productionItems)
        .where(eq(productionItems.id, payload.derivativeItemId))
        .limit(1);
      const compositionUrl = derivative?.descriptProjectId
        ? buildDescriptCompositionUrl(
            derivative.descriptProjectId,
            compositionId,
          )
        : null;
      await recordToolAction({
        contentItemId: payload.derivativeItemId,
        userId: derivative?.editorUserId ?? null,
        tool: "descript",
        action: "clip_created",
        status: "success",
        label: "Clip ready in Descript",
        url: compositionUrl,
        meta: { importPath: "precise-cut" },
      });
    }
    helpers.logger.info(
      `precise-cut ok clip=${payload.clipIdeaId} composition=${compositionId ?? "none"}`,
    );

    // Layout-pack phase: ask Underlord to apply the format's pack-defined
    // treatment to the just-imported composition. Requires the
    // per-promotion opt-in flag (set by the "Precise cut + Underlord"
    // button), a real composition_id, and a pack attached to the format.
    // The service-layer gate already throws on missing pack at promotion
    // time, but we re-check here to handle the edge case where someone
    // detaches the pack between enqueue and execution; in that case we
    // log + skip rather than fail loudly (the import already succeeded).
    if (!payload.applyLayoutPack || !compositionId) {
      return;
    }

    const [row] = await db
      .select({
        descriptProjectId: productionItems.descriptProjectId,
        hook: productionItems.hook,
        compositionName: repurposeTriggers.compositionName,
        formatSkill: formats.instructions,
        formatName: formats.name,
        clipAspectRatio: formats.clipAspectRatio,
        clipTargetPostType: formats.clipTargetPostType,
        clipIdeaExtras: clipIdeas.extras,
      })
      .from(repurposeTriggers)
      .leftJoin(formats, eq(repurposeTriggers.targetFormatId, formats.id))
      .leftJoin(
        productionItems,
        eq(productionItems.id, payload.derivativeItemId),
      )
      .leftJoin(clipIdeas, eq(clipIdeas.id, payload.clipIdeaId))
      .where(eq(repurposeTriggers.id, payload.triggerId))
      .limit(1);
    if (!row?.descriptProjectId) {
      helpers.logger.info(
        `precise-cut layout-skip clip=${payload.clipIdeaId} reason=no_project_id`,
      );
      return;
    }
    if (!row.formatSkill || !row.formatSkill.trim()) {
      helpers.logger.info(
        `precise-cut layout-skip clip=${payload.clipIdeaId} reason=no_skill`,
      );
      return;
    }

    // Hook is set on production_items.hook by the service before enqueue;
    // composition_name on the trigger is the same value. Either is fine.
    const hookText = row.hook ?? row.compositionName ?? "";

    const aspectRatio = resolveClipAspectRatio({
      clipAspectRatio: row.clipAspectRatio,
      clipTargetPostType: row.clipTargetPostType,
    });
    const extras = row.clipIdeaExtras as Record<string, unknown> | null;
    const quotables =
      extras && Array.isArray(extras.quotables)
        ? extras.quotables.filter(
            (v): v is string => typeof v === "string" && v.trim() !== "",
          )
        : [];
    const prompt = buildLayoutPackPrompt({
      skill: row.formatSkill,
      compositionId,
      hookText,
      aspectRatio,
      quotables,
    });
    const agent = await invokeDescriptAgent({
      projectId: row.descriptProjectId,
      prompt,
      caller: "clip-idea-promote-precise-layout",
      productionItemId: payload.derivativeItemId,
    });
    await db
      .update(repurposeTriggers)
      .set({ descriptPrompt: prompt })
      .where(eq(repurposeTriggers.id, payload.triggerId));
    helpers.logger.info(
      `precise-cut layout-start clip=${payload.clipIdeaId} format="${row.formatName ?? "unknown"}" job=${agent.jobId}`,
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
    if (job.result?.status === "error") {
      throw new Error(
        `Descript layout-apply ${layoutJobId} failed: ${job.result.error_message ?? "no error message"}`,
      );
    }
    // Layout-apply mutates the composition in place. compositionId is
    // unchanged from the import phase, so nothing to persist — just log
    // + emit an activity event so the editor can confirm Underlord ran.
    helpers.logger.info(
      `precise-cut layout-ok clip=${payload.clipIdeaId} job=${layoutJobId}`,
    );
    const [editor] = await db
      .select({ editorUserId: productionItems.editorUserId })
      .from(productionItems)
      .where(eq(productionItems.id, payload.derivativeItemId))
      .limit(1);
    await recordToolAction({
      contentItemId: payload.derivativeItemId,
      userId: editor?.editorUserId ?? null,
      tool: "descript",
      action: "layout_applied",
      status: "success",
      label: "Underlord finished applying the layout pack",
      meta: { layoutJobId },
    });
    // Auto-chain into publish-and-archive so the rendered MP4 lands in
    // S3 and the simulator on the detail page picks it up. Wait
    // UNDERLORD_SETTLE_MS before firing — Descript flips the agent job
    // to `stopped` as soon as instructions are dispatched, but the
    // composition mutations (layout pack, captions, filler trims) can
    // still be applying. Publishing immediately renders a pre-layout
    // MP4. Mirrors the chain we wired in `descript-clip-resolve` for
    // the agent flow.
    await helpers.addJob(
      "descript-publish-and-archive",
      { productionItemId: payload.derivativeItemId },
      { runAt: new Date(Date.now() + UNDERLORD_SETTLE_MS) },
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
  // Always re-encode. We previously had a stream-copy fast path with
  // re-encode fallback, but stream-copy + `-ss` before `-i` snaps the
  // output to the nearest preceding keyframe and can produce mp4s with
  // non-zero start timestamps that ffmpeg considers valid (exit 0) but
  // Descript's importer rejects with a generic "Import failed" 1–2s
  // after upload (verified across multiple clips from one source pillar
  // 2026-05-05). Re-encoding is ~real-time on the Basic worker dyno
  // (~80s for an 80s clip), still well inside the 30-min deadline, and
  // produces an mp4 with timestamps starting at 0 that any importer can
  // parse.
  await new Promise<void>((resolve, reject) => {
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
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
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
  args.logger.info("ffmpeg re-encode ok");
}

