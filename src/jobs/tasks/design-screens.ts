// Worker-only: find the SCREENS in a source video — the revenue dashboards,
// analytics, payout pages and charts a founder shows on camera — so a
// design can drop the real screenshot behind them instead of a synthetic
// stat card. Samples the video every ~20s (screen-times.ts), shows the small
// frames to Haiku 5.5 in batches, grabs the flagged moments at full
// resolution and stores them as `design_photos` rows of kind "screen",
// best first. Keyed by the source (pillar) like design-frames; a rescan
// replaces the previous screens. Never touches a design document.
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import type { Task } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { imageSize } from "image-size";
import { db } from "@/lib/db";
import { designPhotos, productionItems } from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import { buildFrameGrabArgs } from "@/lib/design-editor/design-ffmpeg";
import { screenSampleTimes } from "@/lib/design-editor/screen-times";
import { downloadToFile, probeSource, runFfmpeg } from "@/lib/services/ffmpeg-process";
import { FRAME_MAX_WIDTH } from "@/lib/services/design-editor/frames";

export interface DesignScreensPayload {
  /** The SOURCE (pillar) item whose video is scanned. */
  sourceItemId: string;
}

const MODEL = "claude-haiku-5-5";
const SAMPLE_WIDTH = 640;
const BATCH = 12;
const MIN_SCORE = 3;
const MAX_KEPT = 8;
/** Two flagged frames closer than this are the same screen; the better one stays. */
const DEDUPE_SEC = 25;

interface Pick {
  sec: number;
  file: string;
  label: string;
  score: number;
}

export const designScreensTask: Task = async (rawPayload, helpers) => {
  const { sourceItemId } = rawPayload as DesignScreensPayload;
  const [source] = await db.select({ mediaS3Key: productionItems.mediaS3Key, mediaS3Bucket: productionItems.mediaS3Bucket }).from(productionItems).where(eq(productionItems.id, sourceItemId)).limit(1);
  if (!source?.mediaS3Key) {
    helpers.logger.warn(`design-screens: source ${sourceItemId} has no media; nothing to scan`);
    return;
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), "design-screens-"));
  try {
    const local = path.join(workDir, "source.mp4");
    const t0 = Date.now();
    await downloadToFile(await getPresignedGetUrl(source.mediaS3Key, 3600, { bucket: source.mediaS3Bucket ?? undefined }), local);
    const probe = await probeSource(local);
    if (!probe?.durationSec) throw new Error("couldn't read the source video's duration");
    const times = screenSampleTimes(probe.durationSec);
    helpers.logger.info(`design-screens start source=${sourceItemId} duration=${probe.durationSec.toFixed(0)}s samples=${times.length} (download ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    const samples: Array<{ sec: number; file: string }> = [];
    for (const sec of times) {
      const file = path.join(workDir, `s-${sec.toFixed(2).replace(".", "_")}.jpg`);
      try {
        await runFfmpeg(buildFrameGrabArgs({ input: local, sec, maxWidth: SAMPLE_WIDTH, outputPath: file }), { maxRuntimeMs: 60_000, signal: helpers.abortSignal });
        samples.push({ sec, file });
      } catch (err) {
        helpers.logger.warn(`design-screens: frame at ${sec}s failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (samples.length === 0) throw new Error("no frame could be extracted");

    const picks: Pick[] = [];
    for (let i = 0; i < samples.length; i += BATCH) {
      const batch = samples.slice(i, i + BATCH);
      const flagged = await flagScreens(batch.map((s) => s.file));
      for (const f of flagged) {
        const s = batch[f.index];
        if (s && f.score >= MIN_SCORE) picks.push({ sec: s.sec, file: s.file, label: f.label, score: f.score });
      }
    }
    const kept = dedupe(picks).sort((a, b) => b.score - a.score || a.sec - b.sec).slice(0, MAX_KEPT);
    helpers.logger.info(`design-screens flagged=${picks.length} kept=${kept.length}: ${kept.map((k) => `${k.sec.toFixed(0)}s "${k.label}"(${k.score})`).join(", ") || "none"}`);

    // A rescan replaces the previous screens.
    await db.delete(designPhotos).where(and(eq(designPhotos.productionItemId, sourceItemId), eq(designPhotos.kind, "screen")));
    for (const [rank, pick] of kept.entries()) {
      const secStr = pick.sec.toFixed(2);
      const file = path.join(workDir, `screen-${secStr.replace(".", "_")}.jpg`);
      try {
        await runFfmpeg(buildFrameGrabArgs({ input: local, sec: pick.sec, maxWidth: FRAME_MAX_WIDTH, outputPath: file }), { maxRuntimeMs: 120_000, signal: helpers.abortSignal });
        const buf = await readFile(file);
        const dims = imageSize(buf);
        const s3Key = buildKey(sourceItemId, `design-screen-${secStr}.jpg`);
        await putObject(s3Key, buf, "image/jpeg");
        await db
          .insert(designPhotos)
          .values({ productionItemId: sourceItemId, kind: "screen", label: pick.label, s3Bucket: bucketName(), s3Key, width: dims.width ?? null, height: dims.height ?? null, sec: secStr, rank: rank + 1 })
          .onConflictDoNothing();
      } catch (err) {
        helpers.logger.warn(`design-screens: full-res grab at ${secStr}s failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    helpers.logger.info(`design-screens ok source=${sourceItemId} screens=${kept.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

/** Keep one of any two flagged frames closer than DEDUPE_SEC: the better one. */
export function dedupe(picks: Pick[]): Pick[] {
  const byTime = [...picks].sort((a, b) => a.sec - b.sec);
  const out: Pick[] = [];
  for (const p of byTime) {
    const last = out[out.length - 1];
    if (last && p.sec - last.sec < DEDUPE_SEC) {
      if (p.score > last.score) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Haiku looks at a batch of small frames and flags the ones that are a
 * screen (dashboard, chart, payout page, spreadsheet…) rather than a person.
 * Fails soft to "nothing here" — a scan that finds nothing is a valid result.
 */
async function flagScreens(files: string[]): Promise<Array<{ index: number; label: string; score: number }>> {
  try {
    const client = new Anthropic();
    const content: Anthropic.ContentBlockParam[] = [];
    for (const [i, file] of files.entries()) {
      content.push({ type: "text", text: `Frame ${i}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await readFile(file)).toString("base64") } });
    }
    content.push({ type: "text", text: "Flag the frames that are screens. Call flag_screens (with an empty list if none are)." });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system:
        "You scan frames of a founder-interview video for SCREENS: screenshots or screen recordings of revenue dashboards, analytics, payout pages (Stripe, Shopify, App Store, Gumroad, PayPal), charts, spreadsheets, bank balances, user or download counts — on-screen proof of a number an Instagram post could show. Not frames of a person talking, not plain text slides, not B-roll, not a thumbnail with a headline. For each frame that IS a screen give a 2–5 word label of what it shows (\"Stripe revenue graph\", \"App Store downloads\") and a score 1–5 for how usable it is as proof in a post: a big legible number or clean chart filling the frame is 5; small, cluttered or partly covered is 2. Skip everything else.",
      tools: [
        {
          name: "flag_screens",
          description: "The frames that are screens.",
          input_schema: {
            type: "object" as const,
            properties: {
              picks: {
                type: "array",
                items: {
                  type: "object",
                  properties: { index: { type: "integer" }, label: { type: "string" }, score: { type: "integer", minimum: 1, maximum: 5 } },
                  required: ["index", "label", "score"],
                },
              },
            },
            required: ["picks"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "flag_screens" },
      messages: [{ role: "user", content }],
    });
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as { picks?: unknown };
      return (Array.isArray(input.picks) ? input.picks : [])
        .map((p) => p as { index?: unknown; label?: unknown; score?: unknown })
        .filter((p) => typeof p.index === "number" && Number.isInteger(p.index) && p.index >= 0 && p.index < files.length)
        .map((p) => ({ index: p.index as number, label: (typeof p.label === "string" ? p.label : "Screen").slice(0, 60), score: typeof p.score === "number" ? Math.max(1, Math.min(5, Math.round(p.score))) : 3 }));
    }
    return [];
  } catch (err) {
    console.warn("[design-screens] flagging failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
