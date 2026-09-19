/**
 * Dev smoke test for the design editor's render path — builds a Playbook doc
 * from a hardcoded brief and rasterizes every page with satori + resvg. No
 * DB, no S3, no AI.
 *
 *   npx tsx scripts/design-render-smoke.ts [outDir]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { buildPlaybookTemplate } from "../src/lib/design-editor/playbook-template";
import { fillTemplate, listSlots } from "../src/lib/design-editor/template-fill";
import { imageSize } from "image-size";
import { fontsUsed, pageToSatoriTree, type ResolvedImages } from "../src/lib/design-editor/render-tree";

const out = path.resolve(process.argv[2] ?? "/tmp/design-smoke");
mkdirSync(out, { recursive: true });
const template = buildPlaybookTemplate();
const doc = fillTemplate(
  template,
  { caption: "…", values: listSlots(template).map((slot) => (slot.kind === "video" ? { key: slot.key, startSec: 60, endSec: 90 } : { key: slot.key, text: slot.sample })) },
  { photo: { kind: "url", url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg" }, source: { bucket: null, key: "x/source.mp4", title: "How This SaaS Hit $69K/Month In Just 2 Months" }, channel: { name: "Starter Story", subscribers: "800K subscribers" } },
);
(async () => {
  for (const [i, page] of doc.pages.entries()) {
    const images: ResolvedImages = {};
    for (const el of page.elements) {
      if (el.type !== "image") continue;
      if (el.src.kind === "asset") {
        const buf = readFileSync(path.join("public", el.src.path));
        const dims = imageSize(buf);
        images[el.id] = { src: `data:image/png;base64,${buf.toString("base64")}`, width: dims.width, height: dims.height };
      } else if (el.src.kind === "url") images[el.id] = { src: el.src.url, width: 1280, height: 720 };
    }
    const t0 = Date.now();
    const svg = await satori(pageToSatoriTree(page, doc.canvas, images) as never, {
      width: doc.canvas.width,
      height: doc.canvas.height,
      fonts: fontsUsed(page).map((f) => ({
        name: f.cssFamily, weight: f.cssWeight as 400, style: "normal" as const,
        data: readFileSync(path.join("public/fonts/clip-editor", f.metrics.file)),
      })),
    });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: doc.canvas.width } }).render().asPng();
    writeFileSync(path.join(out, `page-${i + 1}.png`), png);
    console.log(`page ${i + 1}: ${page.elements.length} elements, ${png.length} bytes, ${Date.now() - t0}ms`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
