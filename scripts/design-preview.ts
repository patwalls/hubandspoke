/**
 * Dev tool: rasterize a design preset (or a stored doc JSON) to PNGs, one per
 * page, without the worker or S3 — for eyeballing a template against real
 * posts. Bundled assets come from public/; other pictures are fetched.
 *
 *   npx tsx --env-file=.env.local scripts/design-preview.ts <preset|doc.json> <outDir> [substitutePhoto.jpg]
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { imageSize } from "image-size";

async function main() {
  const [what, outDir, photoFile] = process.argv.slice(2);
  if (!what || !outDir) throw new Error("usage: design-preview.ts <preset|doc.json> <outDir> [photo.jpg]");
  const { DESIGN_PRESETS, isDesignPresetId } = await import("../src/lib/design-editor/templates");
  const { parseDesignDoc } = await import("../src/lib/design-editor/doc");
  const { fontsUsed, pageToSatoriTree } = await import("../src/lib/design-editor/render-tree");
  const { getPresignedGetUrl } = await import("../src/lib/s3");
  let doc;
  if (isDesignPresetId(what)) doc = DESIGN_PRESETS[what].build();
  else {
    const parsed = parseDesignDoc(JSON.parse(await readFile(what, "utf8")));
    if (!parsed.ok) throw new Error(parsed.error);
    doc = parsed.doc;
  }
  await mkdir(outDir, { recursive: true });
  const FONT_DIR = path.join(process.cwd(), "public", "fonts", "clip-editor");
  const photo = photoFile ? await readFile(photoFile) : null;
  const images: Record<string, { src: string; width: number; height: number }> = {};
  for (const page of doc.pages) {
    for (const el of page.elements) {
      if (el.type !== "image") continue;
      let buf: Buffer;
      let type = "image/png";
      const isPlaceholder = el.src.kind === "asset" && el.src.path.includes("placeholder");
      if (isPlaceholder && photo && (el.slot?.kind === "photo" || el.slot?.kind === "frame")) {
        buf = photo;
        type = "image/jpeg";
      } else if (el.src.kind === "asset") {
        buf = await readFile(path.join(process.cwd(), "public", el.src.path));
        type = el.src.path.endsWith(".jpg") ? "image/jpeg" : "image/png";
      } else {
        const url = el.src.kind === "url" ? el.src.url : await getPresignedGetUrl(el.src.key, 600, { bucket: el.src.bucket ?? undefined });
        const res = await fetch(url);
        buf = Buffer.from(await res.arrayBuffer());
        type = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      }
      const dims = imageSize(buf);
      images[el.id] = { src: `data:${type};base64,${buf.toString("base64")}`, width: dims.width ?? 1, height: dims.height ?? 1 };
    }
  }
  const channels = { default: { accountId: "x", platform: "youtube", name: "Starter Story", handle: "starterstory", avatarUrl: null, followerCount: 800000, verified: true } };
  for (const [i, page] of doc.pages.entries()) {
    const svg = await satori(pageToSatoriTree(page, doc.canvas, images, { channels: Object.fromEntries(page.elements.filter((e) => e.type === "channel").map((e) => [e.id, channels.default])) as never }) as never, {
      width: doc.canvas.width,
      height: doc.canvas.height,
      fonts: await Promise.all(fontsUsed(page).map(async (f) => ({ name: f.cssFamily, weight: f.cssWeight as 400, style: "normal" as const, data: await readFile(path.join(FONT_DIR, f.metrics.file)) }))),
    });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: doc.canvas.width } }).render().asPng();
    await writeFile(path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.png`), png);
  }
  console.log(`${doc.pages.length} pages → ${outDir}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
