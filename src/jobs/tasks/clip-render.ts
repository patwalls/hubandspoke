import { spawn } from "child_process";
import { copyFile, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Task } from "graphile-worker";
import { desc, eq } from "drizzle-orm";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { db } from "@/lib/db";
import {
  clipEdits,
  clipIdeas,
  clipRenders,
  productionItems,
  transcripts,
} from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedGetUrl, putObjectFromFile } from "@/lib/s3";
import { recordToolAction } from "@/lib/services/content-events";
import { installRenderedClipMedia } from "@/lib/services/clip-editor/install-rendered-media";
import { parseDoc } from "@/lib/clip-editor/doc";
import { compileRenderPlan } from "@/lib/clip-editor/plan";
import { resolveScene } from "@/lib/clip-editor/scene";
import { buildAssScript } from "@/lib/clip-editor/ass";
import {
  buildFilterGraph,
  buildRenderArgs,
  parseProgressSeconds,
} from "@/lib/clip-editor/ffmpeg-args";
import { resolveTranscriptWords } from "@/lib/clip-editor/words";
import { parseSourceDimensions } from "@/lib/clip-editor/video-box";
import { downloadToFile } from "./descript-upload-helpers";

export interface ClipRenderPayload {
  renderId: string;
}

/** Min gap between progress/heartbeat writes — ffmpeg reports ~2×/sec. */
const PROGRESS_WRITE_INTERVAL_MS = 3000;

/**
 * Render one `clip_renders` row to an MP4 and install it as the item's video.
 *
 * Reads ONLY the render row's doc snapshot (never the live edit), so the
 * output is exactly what was exported even if the editor kept editing.
 *
 * Unlike the Descript tasks this is a single long invocation, not a
 * self-re-enqueueing poll chain: an ffmpeg encode can't be resumed, so there
 * is nothing to checkpoint. A deploy's SIGTERM reaches ffmpeg too (same
 * process group) → it exits non-zero → this throws → graphile retries on the
 * new dyno from the top. Idempotency guards at each step make that safe.
 *
 * Failure contract: EVERY failure path stamps status='failed' + error before
 * rethrowing, and the heartbeat covers the one case that can't (SIGKILL) —
 * so the status pill can always offer a retry instead of spinning forever.
 */
export const clipRenderTask: Task = async (rawPayload, helpers) => {
  const { renderId } = rawPayload as ClipRenderPayload;

  const [render] = await db
    .select()
    .from(clipRenders)
    .where(eq(clipRenders.id, renderId))
    .limit(1);
  if (!render) {
    helpers.logger.warn(`clip-render: render ${renderId} not found`);
    return;
  }
  if (render.status === "done" || render.status === "superseded") {
    helpers.logger.info(`clip-render: render ${renderId} already ${render.status}; skipping`);
    return;
  }
  // A newer export for the same edit wins, even if this job got picked first.
  const [newest] = await db
    .select({ id: clipRenders.id })
    .from(clipRenders)
    .where(eq(clipRenders.clipEditId, render.clipEditId))
    .orderBy(desc(clipRenders.createdAt))
    .limit(1);
  if (newest && newest.id !== render.id) {
    await db
      .update(clipRenders)
      .set({ status: "superseded", finishedAt: new Date() })
      .where(eq(clipRenders.id, render.id));
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), `clip-render-${render.id}-`));
  try {
    await db
      .update(clipRenders)
      .set({
        status: "rendering",
        progress: 0,
        error: null,
        startedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(eq(clipRenders.id, render.id));

    const parsed = parseDoc(render.doc);
    if (!parsed.ok) throw new Error(parsed.error);

    const [source] = await db
      .select({
        sourceItemId: clipIdeas.sourceProductionItemId,
        mediaS3Key: productionItems.mediaS3Key,
        mediaS3Bucket: productionItems.mediaS3Bucket,
      })
      .from(clipEdits)
      .innerJoin(clipIdeas, eq(clipIdeas.id, clipEdits.clipIdeaId))
      .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
      .where(eq(clipEdits.id, render.clipEditId))
      .limit(1);
    if (!source?.mediaS3Key) throw new Error("Source media is missing from S3");

    const [transcript] = await db
      .select({ words: transcripts.words, segments: transcripts.segments })
      .from(transcripts)
      .where(eq(transcripts.productionItemId, source.sourceItemId))
      .limit(1);
    const words = transcript ? resolveTranscriptWords(transcript).words : [];

    const plan = compileRenderPlan(parsed.doc, words);
    const scene = resolveScene(plan);
    const hasOverlays = scene.textBlocks.length > 0 || scene.captions !== null;
    const assPath = hasOverlays ? path.join(workDir, "overlay.ass") : null;
    if (assPath) await writeFile(assPath, buildAssScript(plan, scene));
    const sourceUrl = await getPresignedGetUrl(source.mediaS3Key, 3600, {
      bucket: source.mediaS3Bucket ?? undefined,
    });

    // ffmpeg reads a LOCAL copy. The dyno's static ffmpeg segfaults on any
    // https input (see src/lib/services/ffmpeg-process.ts) — the old
    // "probe over https, fall back to a download on failure" order meant the
    // probe always failed there, so the inset/rounded-corner settings were
    // silently ignored in every prod export (2026-09-19).
    const localSource = path.join(workDir, "source");
    const t0 = Date.now();
    await downloadToFile(sourceUrl, localSource);
    helpers.logger.info(`clip-render: source downloaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Exact placement (inset, rounded corners) needs the source's pixel size.
    // A failed probe isn't fatal: the graph falls back to aspect expressions
    // and just can't inset/round.
    const sourceSize = await probeSourceSize(localSource);
    if (!sourceSize) {
      helpers.logger.warn(`clip-render: couldn't probe source size for render=${render.id}; using aspect fallback`);
    }

    // Image layers (logos): each a local file, same order as the plan.
    // Bundled assets are read straight from public/; anything else is
    // downloaded (ffmpeg here must never see an https input).
    const images: string[] = [];
    for (const [i, layer] of plan.imageLayers.entries()) {
      const file = path.join(workDir, `image-${i}`);
      if (layer.src.kind === "asset") {
        await copyFile(path.join(process.cwd(), "public", layer.src.path), file);
      } else {
        const url = layer.src.kind === "s3" ? await getPresignedGetUrl(layer.src.key, 3600, { bucket: layer.src.bucket ?? undefined }) : layer.src.url;
        await downloadToFile(url, file);
      }
      images.push(file);
    }

    const filterScriptPath = path.join(workDir, "graph.txt");
    await writeFile(
      filterScriptPath,
      buildFilterGraph(plan, {
        assPath,
        fontsDir: path.join(process.cwd(), "public", "fonts", "clip-editor"),
        sourceSize,
        imageCount: images.length,
      }),
    );
    const outputPath = path.join(workDir, "clip.mp4");

    helpers.logger.info(
      `clip-render start render=${render.id} item=${render.productionItemId} segments=${plan.segments.length} duration=${plan.durationSec.toFixed(2)}s`,
    );

    const onProgress = makeProgressWriter(render.id, plan.durationSec);
    const started = Date.now();
    await runFfmpeg(
      buildRenderArgs({ plan, input: localSource, images, filterScriptPath, outputPath }),
      onProgress,
    );
    const renderSeconds = (Date.now() - started) / 1000;

    const { size } = await stat(outputPath);
    if (size === 0) throw new Error("ffmpeg produced an empty file");
    const s3Key = buildKey(render.productionItemId, "clip-editor-render.mp4");
    await putObjectFromFile(s3Key, outputPath, "video/mp4");

    await installRenderedClipMedia({
      productionItemId: render.productionItemId,
      renderId: render.id,
      s3Bucket: bucketName(),
      s3Key,
      sizeBytes: size,
    });

    await db
      .update(clipRenders)
      .set({
        status: "done",
        progress: 100,
        error: null,
        outputS3Bucket: bucketName(),
        outputS3Key: s3Key,
        outputSizeBytes: size,
        durationSec: plan.durationSec.toFixed(3),
        renderSeconds: renderSeconds.toFixed(1),
        heartbeatAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(clipRenders.id, render.id));

    await recordToolAction({
      contentItemId: render.productionItemId,
      userId: render.requestedByUserId,
      tool: "clip-editor",
      action: "clip_rendered",
      status: "success",
      label: `Clip rendered (${Math.round(plan.durationSec)}s) — ready to review.`,
      meta: { renderId: render.id, renderSeconds: Math.round(renderSeconds) },
    });
    helpers.logger.info(
      `clip-render ok render=${render.id} s3=${s3Key} (${size}B) in ${renderSeconds.toFixed(1)}s`,
    );
  } catch (err) {
    const message = errMessage(err);
    await db
      .update(clipRenders)
      .set({
        status: "failed",
        error: message.slice(0, 1000),
        finishedAt: new Date(),
      })
      .where(eq(clipRenders.id, render.id));
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

/** `ffmpeg -i <url>` with no output: exits non-zero by design, but prints
 *  the stream banner to stderr first — a ranged read of just the header. */
function probeSourceSize(input: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegInstaller.path, ["-hide_banner", "-i", input], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    proc.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-20_000);
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(parseSourceDimensions(stderr));
    });
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeProgressWriter(renderId: string, durationSec: number) {
  let lastWrite = 0;
  return (renderedSec: number) => {
    const now = Date.now();
    if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
    lastWrite = now;
    // Cap at 95: the last 5% is the S3 upload + media install.
    const progress = Math.min(95, Math.round((renderedSec / Math.max(durationSec, 0.1)) * 95));
    void db
      .update(clipRenders)
      .set({ progress, heartbeatAt: new Date() })
      .where(eq(clipRenders.id, renderId))
      .catch(() => {
        // Progress is cosmetic — never fail a render over it.
      });
  };
}

function runFfmpeg(argv: string[], onProgress: (renderedSec: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegInstaller.path, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const sec = parseProgressSeconds(chunk.toString());
      if (sec !== null) onProgress(sec);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg exited ${code ?? signal}${stderr ? `: ${stderr.trim().slice(-600)}` : ""}`,
          ),
        );
    });
  });
}
