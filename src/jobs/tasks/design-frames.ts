// Worker-only: pull still frames out of a design item's SOURCE video for the
// design editor's cover photo. Two modes (see services/design-editor/frames.ts):
//   auto  — ~12 evenly spaced frames, then Haiku 4.5 looks at them and marks
//           the best founder shot (`is_pick`) so the first draft has a real
//           photo instead of whatever thumbnail enrichment left behind;
//   atSec — one frame at an exact time the editor scrubbed to.
// Each frame is a row in design_frames, pending → done|failed, so the editor
// can show the filmstrip filling in. Never touches the design document.
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import type { Task } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { imageSize } from "image-size";
import { db } from "@/lib/db";
import { designFrames, productionItems } from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import { buildFrameGrabArgs } from "@/lib/design-editor/design-ffmpeg";
import { probeSource, runFfmpeg } from "@/lib/services/ffmpeg-process";
import { AUTO_FRAME_COUNT, FRAME_WIDTH } from "@/lib/services/design-editor/frames";

export interface DesignFramesPayload {
  productionItemId: string;
  sourceItemId: string;
  /** Present → grab this one frame; absent → the auto filmstrip + pick. */
  atSec?: number;
}

const PICK_MODEL = "claude-haiku-4-5-20251001";

export const designFramesTask: Task = async (rawPayload, helpers) => {
  const { productionItemId, sourceItemId, atSec } = rawPayload as DesignFramesPayload;
  const [source] = await db
    .select({ mediaS3Key: productionItems.mediaS3Key, mediaS3Bucket: productionItems.mediaS3Bucket })
    .from(productionItems)
    .where(eq(productionItems.id, sourceItemId))
    .limit(1);
  if (!source?.mediaS3Key) {
    helpers.logger.warn(`design-frames: source ${sourceItemId} has no media; nothing to grab`);
    if (atSec !== undefined) await markFailed(productionItemId, atSec, "The source video isn't archived yet");
    return;
  }
  const sourceUrl = await getPresignedGetUrl(source.mediaS3Key, 3600, { bucket: source.mediaS3Bucket ?? undefined });
  const workDir = await mkdtemp(path.join(os.tmpdir(), "design-frames-"));
  try {
    if (atSec !== undefined) {
      await grabOne(productionItemId, sourceUrl, atSec, workDir, "user");
      return;
    }

    const durationSec = (await probeSource(sourceUrl))?.durationSec ?? null;
    if (!durationSec) throw new Error("couldn't read the source video's duration");
    // Skip the very start (title cards) and end (outro) of the video.
    const secs = Array.from({ length: AUTO_FRAME_COUNT }, (_, i) => round2(durationSec * (0.04 + (0.92 * i) / (AUTO_FRAME_COUNT - 1))));
    await db
      .insert(designFrames)
      .values(secs.map((sec) => ({ productionItemId, sec: sec.toFixed(2), origin: "auto", status: "pending" })))
      .onConflictDoNothing();
    helpers.logger.info(`design-frames start item=${productionItemId} source=${sourceItemId} duration=${durationSec.toFixed(0)}s frames=${secs.length}`);

    const done: Array<{ sec: number; file: string }> = [];
    for (const sec of secs) {
      const file = await grabOne(productionItemId, sourceUrl, sec, workDir, "auto");
      if (file) done.push({ sec, file });
    }
    if (done.length === 0) throw new Error("no frame could be extracted");

    const pick = await pickBestFrame(done.map((d) => d.file));
    const chosen = done[pick.index] ?? done[Math.floor(done.length / 2)];
    await db.update(designFrames).set({ isPick: false }).where(eq(designFrames.productionItemId, productionItemId));
    await db
      .update(designFrames)
      .set({ isPick: true, updatedAt: new Date() })
      .where(and(eq(designFrames.productionItemId, productionItemId), eq(designFrames.sec, chosen.sec.toFixed(2))));
    helpers.logger.info(`design-frames ok item=${productionItemId} frames=${done.length} pick=${chosen.sec}s (${pick.reason})`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

/** Grab, upload and stamp one frame. Returns the local file on success. */
async function grabOne(productionItemId: string, sourceUrl: string, sec: number, workDir: string, origin: "auto" | "user"): Promise<string | null> {
  const secStr = round2(sec).toFixed(2);
  await db.insert(designFrames).values({ productionItemId, sec: secStr, origin, status: "pending" }).onConflictDoNothing();
  const file = path.join(workDir, `frame-${secStr.replace(".", "_")}.jpg`);
  try {
    await runFfmpeg(buildFrameGrabArgs({ input: sourceUrl, sec, width: FRAME_WIDTH, outputPath: file }), { timeoutMs: 120_000 });
    const buf = await readFile(file);
    if (buf.length === 0) throw new Error("empty frame");
    const dims = imageSize(buf);
    const s3Key = buildKey(productionItemId, `design-frame-${secStr}.jpg`);
    await putObject(s3Key, buf, "image/jpeg");
    await db
      .update(designFrames)
      .set({ status: "done", s3Bucket: bucketName(), s3Key, width: dims.width, height: dims.height, error: null, updatedAt: new Date() })
      .where(and(eq(designFrames.productionItemId, productionItemId), eq(designFrames.sec, secStr)));
    return file;
  } catch (err) {
    await markFailed(productionItemId, sec, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function markFailed(productionItemId: string, sec: number, error: string) {
  await db
    .update(designFrames)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(designFrames.productionItemId, productionItemId), eq(designFrames.sec, round2(sec).toFixed(2))));
}

/**
 * Haiku looks at the filmstrip and picks the cover: the founder's face,
 * clear and well lit, no burned-in text, no mid-word grimace. Fails soft to
 * the middle frame — a mediocre photo beats no photo.
 */
async function pickBestFrame(files: string[]): Promise<{ index: number; reason: string }> {
  const fallback = { index: Math.floor(files.length / 2), reason: "fallback: middle frame" };
  try {
    const client = new Anthropic();
    const content: Anthropic.ContentBlockParam[] = [];
    for (const [i, file] of files.entries()) {
      content.push({ type: "text", text: `Frame ${i}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(file)).toString("base64") } });
    }
    content.push({ type: "text", text: "Which frame is the best cover photo? Call pick_cover_frame." });
    const res = await client.messages.create({
      model: PICK_MODEL,
      max_tokens: 300,
      system:
        "You choose the cover photo for an Instagram post about a founder interview. Pick the frame where the main person (the founder, usually the guest, not the host) is most clearly visible: face sharp and well lit, eyes open, a natural or confident expression, framed so a headline can sit over the lower half. Avoid frames with burned-in text or graphics, screen recordings, mid-blink or mid-word faces, and frames where the person is tiny or cut off. If several are good, prefer one where the person looks toward the camera.",
      tools: [
        {
          name: "pick_cover_frame",
          description: "Choose the best frame.",
          input_schema: {
            type: "object" as const,
            properties: { index: { type: "integer", description: "The frame number." }, reason: { type: "string", description: "One short sentence." } },
            required: ["index", "reason"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "pick_cover_frame" },
      messages: [{ role: "user", content }],
    });
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as { index?: unknown; reason?: unknown };
      const index = typeof input.index === "number" ? Math.round(input.index) : NaN;
      if (Number.isInteger(index) && index >= 0 && index < files.length) {
        return { index, reason: typeof input.reason === "string" ? input.reason.slice(0, 200) : "" };
      }
    }
    return fallback;
  } catch (err) {
    console.warn("[design-frames] pick failed:", err instanceof Error ? err.message : err);
    return fallback;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
