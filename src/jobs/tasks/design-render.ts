// Worker-only: rasterizes a design_renders row's pages (satori → SVG,
// resvg → PNG), uploads them and installs them as the item's carousel.
// Same failure contract as clip-render.ts: every failure path stamps the row,
// the heartbeat covers SIGKILL, done/superseded rows are no-ops.
import { readFile } from "fs/promises";
import path from "path";
import type { Task } from "graphile-worker";
import { desc, eq } from "drizzle-orm";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { db } from "@/lib/db";
import { designRenders } from "@/lib/db/schema";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import { recordToolAction } from "@/lib/services/content-events";
import { installDesignMedia } from "@/lib/services/design-editor/install-design-media";
import { parseDesignDoc, type DesignImageSource } from "@/lib/design-editor/doc";
import { fontsUsed, pageToSatoriTree, type ResolvedImages } from "@/lib/design-editor/render-tree";

export interface DesignRenderPayload {
  renderId: string;
}

const FONT_DIR = path.join(process.cwd(), "public", "fonts", "clip-editor");
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

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

  try {
    await db.update(designRenders).set({ status: "rendering", progress: 0, error: null, startedAt: new Date(), heartbeatAt: new Date() }).where(eq(designRenders.id, render.id));
    const parsed = parseDesignDoc(render.doc);
    if (!parsed.ok) throw new Error(parsed.error);
    const doc = parsed.doc;
    const started = Date.now();
    const pages: Array<{ s3Key: string; sizeBytes: number }> = [];

    for (const [i, page] of doc.pages.entries()) {
      const images: ResolvedImages = {};
      for (const el of page.elements) {
        if (el.type === "image") images[el.id] = await loadImageDataUrl(el.src);
      }
      const svg = await satori(pageToSatoriTree(page, doc.canvas, images) as never, {
        width: doc.canvas.width,
        height: doc.canvas.height,
        fonts: await Promise.all(
          fontsUsed(page).map(async (f) => ({
            name: f.cssFamily,
            weight: f.cssWeight as 400,
            style: "normal" as const,
            data: await readFile(path.join(FONT_DIR, f.metrics.file)),
          })),
        ),
      });
      const png = new Resvg(svg, { fitTo: { mode: "width", value: doc.canvas.width } }).render().asPng();
      const s3Key = buildKey(render.productionItemId, `design-page-${i + 1}.png`);
      await putObject(s3Key, png, "image/png");
      pages.push({ s3Key, sizeBytes: png.length });
      await db
        .update(designRenders)
        .set({ progress: Math.round(((i + 1) / doc.pages.length) * 90), heartbeatAt: new Date() })
        .where(eq(designRenders.id, render.id));
    }

    await installDesignMedia({ productionItemId: render.productionItemId, renderId: render.id, s3Bucket: bucketName(), pages });
    const renderSeconds = (Date.now() - started) / 1000;
    await db
      .update(designRenders)
      .set({ status: "done", progress: 100, error: null, outputKeys: pages.map((p) => p.s3Key), renderSeconds: renderSeconds.toFixed(1), heartbeatAt: new Date(), finishedAt: new Date() })
      .where(eq(designRenders.id, render.id));
    await recordToolAction({
      contentItemId: render.productionItemId,
      userId: render.requestedByUserId,
      tool: "design-editor",
      action: "design_rendered",
      status: "success",
      label: `${pages.length}-slide post rendered — ready to review.`,
      meta: { renderId: render.id, pages: pages.length },
    });
    helpers.logger.info(`design-render ok render=${render.id} pages=${pages.length} in ${renderSeconds.toFixed(1)}s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(designRenders).set({ status: "failed", error: message.slice(0, 1000), finishedAt: new Date() }).where(eq(designRenders.id, render.id));
    throw err;
  }
};

/** satori takes data URLs; fetching ourselves also gives one place to cap
 *  size and to map our own asset paths to files on disk. */
async function loadImageDataUrl(src: DesignImageSource): Promise<string> {
  if (src.kind === "asset") {
    const file = path.join(process.cwd(), "public", src.path);
    const buf = await readFile(file);
    return `data:${mimeFor(src.path)};base64,${buf.toString("base64")}`;
  }
  const url = src.kind === "url" ? src.url : await getPresignedGetUrl(src.key, 3600, { bucket: src.bucket ?? undefined });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed (${res.status}) for ${src.kind}`);
  const type = res.headers.get("content-type")?.split(";")[0] || mimeFor(url);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (!type.startsWith("image/")) throw new Error(`not an image (${type}) for ${src.kind} source`);
  if (length > MAX_IMAGE_BYTES) throw new Error(`image too large (${length} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${buf.length} bytes)`);
  return `data:${type};base64,${buf.toString("base64")}`;
}

function mimeFor(p: string): string {
  const ext = p.toLowerCase().split("?")[0].split(".").pop();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}
