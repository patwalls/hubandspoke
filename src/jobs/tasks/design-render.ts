// Worker-only: renders a design_renders row's pages and installs them as the
// item's carousel. Image pages: satori → SVG → resvg → PNG. Video pages: the
// page is baked as two stills (under/over the footage), then ffmpeg cuts the
// clip out of the source, stacks the stills around it and burns the captions
// in (design-ffmpeg.ts). Same failure contract as clip-render.ts: every
// failure path stamps the row, the heartbeat covers SIGKILL, done/superseded
// rows are no-ops.
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { Task } from "graphile-worker";
import { desc, eq } from "drizzle-orm";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { imageSize } from "image-size";
import { db } from "@/lib/db";
import { designRenders, productionItems, transcripts } from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedGetUrl, putObject, putObjectFromFile } from "@/lib/s3";
import { recordToolAction } from "@/lib/services/content-events";
import { installDesignMedia } from "@/lib/services/design-editor/install-design-media";
import { downloadToFile, probeSource, runFfmpeg } from "@/lib/services/ffmpeg-process";
import { pageVideo, parseDesignDoc, type DesignImageSource, type DesignPage } from "@/lib/design-editor/doc";
import { fontsUsed, pageToSatoriTree, videoPageLayers, type ResolvedChannels, type ResolvedImages } from "@/lib/design-editor/render-tree";
import { loadBrandChannels, resolveChannel } from "@/lib/services/design-editor/channels";
import { avatarFetchUrl } from "@/lib/services/account-avatar";
import { buildDesignCaptionCues } from "@/lib/design-editor/captions";
import { buildCaptionsAss } from "@/lib/design-editor/design-ass";
import { buildFrameGrabArgs, buildVideoPageArgs, buildVideoPageFilterGraph } from "@/lib/design-editor/design-ffmpeg";
import { resolveTranscriptWords, type EditorWord } from "@/lib/clip-editor/words";

export interface DesignRenderPayload {
  renderId: string;
}

const FONT_DIR = path.join(process.cwd(), "public", "fonts", "clip-editor");
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type RenderedPage = { s3Key: string; sizeBytes: number; kind: "image" | "video"; contentType: string; posterS3Key: string | null };

export const designRenderTask: Task = async (rawPayload, helpers) => {
  const { renderId } = rawPayload as DesignRenderPayload;
  const [render] = await db.select().from(designRenders).where(eq(designRenders.id, renderId)).limit(1);
  if (!render) return helpers.logger.warn(`design-render: ${renderId} not found`);
  if (render.status === "done" || render.status === "superseded") return;
  const [newest] = await db.select({ id: designRenders.id }).from(designRenders).where(eq(designRenders.designDocId, render.designDocId)).orderBy(desc(designRenders.createdAt)).limit(1);
  if (newest && newest.id !== render.id) {
    await db.update(designRenders).set({ status: "superseded", finishedAt: new Date() }).where(eq(designRenders.id, render.id));
    return;
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "design-render-"));
  try {
    await db.update(designRenders).set({ status: "rendering", progress: 0, error: null, startedAt: new Date(), heartbeatAt: new Date() }).where(eq(designRenders.id, render.id));
    const parsed = parseDesignDoc(render.doc);
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parsed.doc;
    const started = Date.now();
    const pages: RenderedPage[] = [];
    // Video pages are ~90% of the work; weight progress by that.
    const weights = doc.pages.map((p) => (pageVideo(p) ? 10 : 1));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let doneWeight = 0;
    let words: EditorWord[] | null = null;
    // ffmpeg reads local files only on the dyno (ffmpeg-process.ts); one
    // download per distinct source, reused across the render's video pages.
    const localSources = new Map<string, string>();
    const localSourceFor = async (src: { bucket: string | null; key: string }): Promise<string> => {
      const cacheKey = `${src.bucket ?? ""}/${src.key}`;
      const hit = localSources.get(cacheKey);
      if (hit) return hit;
      const url = await getPresignedGetUrl(src.key, 3600, { bucket: src.bucket ?? undefined });
      const file = path.join(workDir, `source-${localSources.size}.mp4`);
      const t0 = Date.now();
      await downloadToFile(url, file);
      helpers.logger.info(`design-render: source downloaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      localSources.set(cacheKey, file);
      return file;
    };
    const [itemRow] = await db.select({ brand: productionItems.brand }).from(productionItems).where(eq(productionItems.id, render.productionItemId)).limit(1);
    const brandChannels = await loadBrandChannels(itemRow?.brand ?? "starter-story");

    for (const [i, page] of doc.pages.entries()) {
      const images: ResolvedImages = {};
      const channels: ResolvedChannels = {};
      for (const el of page.elements) {
        if (el.type === "image") images[el.id] = await loadImage(el.src);
        if (el.type === "channel") {
          const info = resolveChannel(el, brandChannels);
          channels[el.id] = info;
          // The avatar is a platform CDN URL; if it can't be fetched the
          // element falls back to the initial in a circle.
          if (info?.avatarUrl) {
            try {
              images[el.id] = await loadImage({ kind: "url", url: (await avatarFetchUrl(info.avatarUrl)) ?? info.avatarUrl });
            } catch (err) {
              helpers.logger.warn(`design-render: avatar fetch failed for ${info.accountId}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      }
      const video = pageVideo(page);
      if (!video) {
        const png = await rasterize(page, doc.canvas, images, false, channels);
        const s3Key = buildKey(render.productionItemId, `design-page-${i + 1}.png`);
        await putObject(s3Key, png, "image/png");
        pages.push({ s3Key, sizeBytes: png.length, kind: "image", contentType: "image/png", posterS3Key: null });
      } else {
        words ??= await loadSourceWords(render.productionItemId);
        const layers = videoPageLayers(page);
        const underPath = path.join(workDir, `p${i}-under.png`);
        const overPath = path.join(workDir, `p${i}-over.png`);
        await writeFile(underPath, await rasterize(layers.under, doc.canvas, images, false, channels));
        await writeFile(overPath, await rasterize(layers.over, doc.canvas, images, true, channels));

        let assPath: string | null = null;
        const captions = page.elements.find((el) => el.type === "captions");
        if (captions && captions.type === "captions") {
          const cues = buildDesignCaptionCues(words, video, captions.maxWordsPerCue);
          if (cues.length > 0) {
            assPath = path.join(workDir, `p${i}-captions.ass`);
            await writeFile(assPath, buildCaptionsAss(captions, cues, doc.canvas));
          }
        }

        if (!video.src) throw new Error(`page ${i + 1}: the clip has no source video`);
        const sourceUrl = await localSourceFor(video.src);
        const probe = await probeSource(sourceUrl);
        if (!probe) throw new Error("couldn't read the source video");
        const filterScriptPath = path.join(workDir, `p${i}-graph.txt`);
        await writeFile(filterScriptPath, buildVideoPageFilterGraph({ video, sourceSize: probe, canvas: doc.canvas, assPath, fontsDir: FONT_DIR }));
        const outputPath = path.join(workDir, `p${i}.mp4`);
        const clipSec = Math.max(0.1, video.endSec - video.startSec);
        const baseWeight = doneWeight;
        const w = weights[i];
        helpers.logger.info(`design-render page=${i + 1} video clip=${video.startSec.toFixed(1)}–${video.endSec.toFixed(1)}s`);
        await runFfmpeg(buildVideoPageArgs({ video, underPath, overPath, input: sourceUrl, filterScriptPath, outputPath }), {
          onProgress: (sec) => {
            const p = Math.round(((baseWeight + (Math.min(sec, clipSec) / clipSec) * w) / totalWeight) * 90);
            void db.update(designRenders).set({ progress: p, heartbeatAt: new Date() }).where(eq(designRenders.id, render.id)).catch(() => {});
          },
        });
        const { size } = await stat(outputPath);
        if (size === 0) throw new Error("ffmpeg produced an empty file");
        const posterPath = path.join(workDir, `p${i}-poster.jpg`);
        await runFfmpeg(buildFrameGrabArgs({ input: outputPath, sec: 0, width: doc.canvas.width, outputPath: posterPath }), { timeoutMs: 60_000 });
        const s3Key = buildKey(render.productionItemId, `design-page-${i + 1}.mp4`);
        const posterS3Key = buildKey(render.productionItemId, `design-page-${i + 1}-poster.jpg`);
        await putObjectFromFile(s3Key, outputPath, "video/mp4");
        await putObjectFromFile(posterS3Key, posterPath, "image/jpeg");
        pages.push({ s3Key, sizeBytes: size, kind: "video", contentType: "video/mp4", posterS3Key });
      }
      doneWeight += weights[i];
      await db
        .update(designRenders)
        .set({ progress: Math.round((doneWeight / totalWeight) * 90), heartbeatAt: new Date() })
        .where(eq(designRenders.id, render.id));
    }

    await installDesignMedia({ productionItemId: render.productionItemId, renderId: render.id, s3Bucket: bucketName(), pages });
    const renderSeconds = (Date.now() - started) / 1000;
    await db
      .update(designRenders)
      .set({ status: "done", progress: 100, error: null, outputKeys: pages.map((p) => p.s3Key), renderSeconds: renderSeconds.toFixed(1), heartbeatAt: new Date(), finishedAt: new Date() })
      .where(eq(designRenders.id, render.id));
    const videos = pages.filter((p) => p.kind === "video").length;
    await recordToolAction({
      contentItemId: render.productionItemId,
      userId: render.requestedByUserId,
      tool: "design-editor",
      action: "design_rendered",
      status: "success",
      label: `${pages.length}-slide post rendered${videos ? ` (${videos} video)` : ""} — ready to review.`,
      meta: { renderId: render.id, pages: pages.length, videos },
    });
    helpers.logger.info(`design-render ok render=${render.id} pages=${pages.length} videos=${videos} in ${renderSeconds.toFixed(1)}s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(designRenders).set({ status: "failed", error: message.slice(0, 1000), finishedAt: new Date() }).where(eq(designRenders.id, render.id));
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

async function rasterize(page: DesignPage, canvas: { width: number; height: number }, images: ResolvedImages, transparent: boolean, channels: ResolvedChannels = {}): Promise<Buffer> {
  const svg = await satori(pageToSatoriTree(page, canvas, images, { transparent, channels }) as never, {
    width: canvas.width,
    height: canvas.height,
    fonts: await Promise.all(
      fontsUsed(page).map(async (f) => ({
        name: f.cssFamily,
        weight: f.cssWeight as 400,
        style: "normal" as const,
        data: await readFile(path.join(FONT_DIR, f.metrics.file)),
      })),
    ),
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: canvas.width } }).render().asPng();
}

/** The words of the source (pillar) transcript, for the captions. */
async function loadSourceWords(productionItemId: string): Promise<EditorWord[]> {
  const [item] = await db.select({ pillarContentItemId: productionItems.pillarContentItemId }).from(productionItems).where(eq(productionItems.id, productionItemId)).limit(1);
  const sourceId = item?.pillarContentItemId ?? productionItemId;
  const [t] = await db.select({ words: transcripts.words, segments: transcripts.segments }).from(transcripts).where(eq(transcripts.productionItemId, sourceId)).limit(1);
  if (!t) return [];
  return resolveTranscriptWords({ words: t.words, segments: t.segments ?? [] }).words;
}

/** satori takes data URLs; fetching ourselves also gives one place to cap
 *  size, read the pixel size (the crop needs it) and map our own asset
 *  paths to files on disk. */
async function loadImage(src: DesignImageSource): Promise<ResolvedImages[string]> {
  let buf: Buffer;
  let type: string;
  if (src.kind === "asset") {
    buf = await readFile(path.join(process.cwd(), "public", src.path));
    type = mimeFor(src.path);
  } else {
    const url = src.kind === "url" ? src.url : await getPresignedGetUrl(src.key, 3600, { bucket: src.bucket ?? undefined });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image fetch failed (${res.status}) for ${src.kind}`);
    type = res.headers.get("content-type")?.split(";")[0] || mimeFor(url);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (!type.startsWith("image/")) throw new Error(`not an image (${type}) for ${src.kind} source`);
    if (length > MAX_IMAGE_BYTES) throw new Error(`image too large (${length} bytes)`);
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${buf.length} bytes)`);
  }
  const dims = imageSize(buf);
  if (!dims.width || !dims.height) throw new Error(`couldn't read image size for ${src.kind} source`);
  return { src: `data:${type};base64,${buf.toString("base64")}`, width: dims.width, height: dims.height };
}

function mimeFor(p: string): string {
  const ext = p.toLowerCase().split("?")[0].split(".").pop();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}
