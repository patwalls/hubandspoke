// Worker-only: a SOURCE video's photo library — still frames of the founder
// for the design editor's cover and picture panel, shared by every post made
// from the video. Two modes (see services/design-editor/frames.ts):
//   auto  — ~12 frames, sampled where the GUEST is talking when the
//           transcript knows (frame-times.ts), then Haiku 4.5 ranks the best
//           founder shots: rank 1 is the cover pick;
//   atSec — one frame at an exact time the editor scrubbed to.
// The source is downloaded to the dyno first: the static ffmpeg there
// segfaults on https input (see ffmpeg-process.ts). Each frame is a row in
// design_frames, pending → done|failed. Never touches a design document.
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import type { Task } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { imageSize } from "image-size";
import { db } from "@/lib/db";
import { designFrames, productionItems, transcripts } from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import { buildFrameGrabArgs } from "@/lib/design-editor/design-ffmpeg";
import { frameTimes } from "@/lib/design-editor/frame-times";
import { resolveTranscriptWords } from "@/lib/clip-editor/words";
import { downloadToFile, probeSource, runFfmpeg } from "@/lib/services/ffmpeg-process";
import { AUTO_FRAME_COUNT, FRAME_WIDTH } from "@/lib/services/design-editor/frames";

export interface DesignFramesPayload {
  /** The SOURCE (pillar) item whose video the frames come from. */
  sourceItemId: string;
  /** Present → grab this one frame; absent → the auto filmstrip + ranking. */
  atSec?: number;
  /** Legacy payloads (before 2026-09-20) carried the derivative here. */
  productionItemId?: string;
}

const PICK_MODEL = "claude-haiku-4-5-20251001";
const BEST_SHOTS = 3;

export const designFramesTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as DesignFramesPayload;
  const sourceItemId = payload.sourceItemId;
  const atSec = payload.atSec;
  const [source] = await db
    .select({ mediaS3Key: productionItems.mediaS3Key, mediaS3Bucket: productionItems.mediaS3Bucket })
    .from(productionItems)
    .where(eq(productionItems.id, sourceItemId))
    .limit(1);
  if (!source?.mediaS3Key) {
    helpers.logger.warn(`design-frames: source ${sourceItemId} has no media; nothing to grab`);
    if (atSec !== undefined) await markFailed(sourceItemId, atSec, "The source video isn't archived yet");
    return;
  }
  const sourceUrl = await getPresignedGetUrl(source.mediaS3Key, 3600, { bucket: source.mediaS3Bucket ?? undefined });
  const workDir = await mkdtemp(path.join(os.tmpdir(), "design-frames-"));
  try {
    const local = path.join(workDir, "source.mp4");
    const t0 = Date.now();
    await downloadToFile(sourceUrl, local);
    helpers.logger.info(`design-frames: source downloaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (atSec !== undefined) {
      await grabOne(sourceItemId, local, atSec, workDir, "user");
      return;
    }

    const probe = await probeSource(local);
    const transcript = await loadTranscript(sourceItemId);
    const durationSec = probe?.durationSec ?? (transcript.words.length ? transcript.words[transcript.words.length - 1].endSec + 1 : null);
    if (!durationSec) throw new Error("couldn't read the source video's duration");
    const secs = frameTimes({ durationSec, count: AUTO_FRAME_COUNT, words: transcript.words, speakers: transcript.speakers });
    await db
      .insert(designFrames)
      .values(secs.map((sec) => ({ productionItemId: sourceItemId, sec: sec.toFixed(2), origin: "auto", status: "pending" })))
      .onConflictDoNothing();
    helpers.logger.info(`design-frames start source=${sourceItemId} duration=${durationSec.toFixed(0)}s frames=${secs.length} guestAware=${transcript.speakers.some((s) => s.role === "guest")}`);

    const done: Array<{ sec: number; file: string }> = [];
    for (const sec of secs) {
      const file = await grabOne(sourceItemId, local, sec, workDir, "auto");
      if (file) done.push({ sec, file });
    }
    if (done.length === 0) throw new Error("no frame could be extracted");

    const ranking = await rankFrames(done.map((d) => d.file));
    await db.update(designFrames).set({ isPick: false, rank: null }).where(eq(designFrames.productionItemId, sourceItemId));
    for (const [i, idx] of ranking.order.entries()) {
      const frame = done[idx];
      if (!frame) continue;
      await db
        .update(designFrames)
        .set({ rank: i + 1, isPick: i === 0, updatedAt: new Date() })
        .where(and(eq(designFrames.productionItemId, sourceItemId), eq(designFrames.sec, frame.sec.toFixed(2))));
    }
    helpers.logger.info(`design-frames ok source=${sourceItemId} frames=${done.length} best=${ranking.order.map((i) => done[i]?.sec).join(",")} (${ranking.reason})`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

async function loadTranscript(sourceItemId: string) {
  const [t] = await db.select({ words: transcripts.words, segments: transcripts.segments, speakers: transcripts.speakers }).from(transcripts).where(eq(transcripts.productionItemId, sourceItemId)).limit(1);
  if (!t) return { words: [], speakers: [] as Array<{ id: string; role: string }> };
  return { words: resolveTranscriptWords({ words: t.words, segments: t.segments ?? [] }).words, speakers: (t.speakers ?? []).map((s) => ({ id: s.id, role: s.role })) };
}

/** Grab, upload and stamp one frame. Returns the local file on success. */
async function grabOne(sourceItemId: string, localSource: string, sec: number, workDir: string, origin: "auto" | "user"): Promise<string | null> {
  const secStr = round2(sec).toFixed(2);
  await db.insert(designFrames).values({ productionItemId: sourceItemId, sec: secStr, origin, status: "pending" }).onConflictDoNothing();
  const file = path.join(workDir, `frame-${secStr.replace(".", "_")}.jpg`);
  try {
    await runFfmpeg(buildFrameGrabArgs({ input: localSource, sec, width: FRAME_WIDTH, outputPath: file }), { timeoutMs: 120_000 });
    const buf = await readFile(file);
    if (buf.length === 0) throw new Error("empty frame");
    const dims = imageSize(buf);
    const s3Key = buildKey(sourceItemId, `design-frame-${secStr}.jpg`);
    await putObject(s3Key, buf, "image/jpeg");
    await db
      .update(designFrames)
      .set({ status: "done", s3Bucket: bucketName(), s3Key, width: dims.width, height: dims.height, error: null, updatedAt: new Date() })
      .where(and(eq(designFrames.productionItemId, sourceItemId), eq(designFrames.sec, secStr)));
    return file;
  } catch (err) {
    await markFailed(sourceItemId, sec, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function markFailed(sourceItemId: string, sec: number, error: string) {
  await db
    .update(designFrames)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(designFrames.productionItemId, sourceItemId), eq(designFrames.sec, round2(sec).toFixed(2))));
}

/**
 * Haiku looks at the filmstrip and ranks the best founder shots: the guest,
 * face sharp and well lit, no burned-in text, room for a headline. Fails
 * soft to "middle frames first" — a mediocre photo beats no photo.
 */
async function rankFrames(files: string[]): Promise<{ order: number[]; reason: string }> {
  const mid = Math.floor(files.length / 2);
  const fallback = { order: [mid, ...files.map((_, i) => i).filter((i) => i !== mid)].slice(0, BEST_SHOTS), reason: "fallback: middle frames" };
  try {
    const client = new Anthropic();
    const content: Anthropic.ContentBlockParam[] = [];
    for (const [i, file] of files.entries()) {
      content.push({ type: "text", text: `Frame ${i}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(file)).toString("base64") } });
    }
    content.push({ type: "text", text: `Rank the ${BEST_SHOTS} best cover photos, best first. Call rank_cover_frames.` });
    const res = await client.messages.create({
      model: PICK_MODEL,
      max_tokens: 400,
      system:
        "You choose cover photos for Instagram posts about a founder interview. The post is about the GUEST (the founder), not the host who interviews them; when two people are on screen side by side, prefer frames where the guest is the clearer, larger or better-lit one. Rank frames where the person's face is sharp and well lit, eyes open, a natural or confident expression, framed so a headline can sit over the lower half. Avoid frames with burned-in text or graphics, screen recordings, slides, mid-blink or mid-word faces, and frames where the person is tiny or cut off. Prefer looking toward the camera. Never pick the same shot twice.",
      tools: [
        {
          name: "rank_cover_frames",
          description: "The best frames, best first.",
          input_schema: {
            type: "object" as const,
            properties: {
              indices: { type: "array", items: { type: "integer" }, description: `Frame numbers, best first, up to ${BEST_SHOTS}.` },
              reason: { type: "string", description: "One short sentence about the top pick." },
            },
            required: ["indices", "reason"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "rank_cover_frames" },
      messages: [{ role: "user", content }],
    });
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as { indices?: unknown; reason?: unknown };
      const order = (Array.isArray(input.indices) ? input.indices : [])
        .map((n) => (typeof n === "number" ? Math.round(n) : NaN))
        .filter((n, i, arr) => Number.isInteger(n) && n >= 0 && n < files.length && arr.indexOf(n) === i)
        .slice(0, BEST_SHOTS);
      if (order.length > 0) return { order, reason: typeof input.reason === "string" ? input.reason.slice(0, 200) : "" };
    }
    return fallback;
  } catch (err) {
    console.warn("[design-frames] ranking failed:", err instanceof Error ? err.message : err);
    return fallback;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
