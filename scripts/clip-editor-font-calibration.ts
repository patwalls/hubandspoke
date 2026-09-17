/**
 * Dev check: for every registered clip-editor font, render a hook through the
 * REAL layout → ASS → libass path and measure where the glyphs actually land,
 * against where layout.ts says they should (cap top + baseline of an "H").
 *
 *   npx tsx scripts/clip-editor-font-calibration.ts
 *
 * Run after adding a font. A font whose rows are off by more than ~2px has
 * metrics libass reads differently from fonts.ts's assumptions (win ascent /
 * descent) — fix the registry entry before shipping it, or the preview and
 * the export will disagree for that font. Needs Pillow (`pip install pillow`).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { FONT_IDS, createDefaultDoc } from "../src/lib/clip-editor/doc";
import { FONTS } from "../src/lib/clip-editor/fonts";
import { compileRenderPlan } from "../src/lib/clip-editor/plan";
import { resolveScene } from "../src/lib/clip-editor/scene";
import { buildAssScript } from "../src/lib/clip-editor/ass";

const outDir = path.resolve(process.argv[2] ?? "/tmp/clip-editor-font-calibration");
mkdirSync(outDir, { recursive: true });
let worst = 0;

for (const fontId of FONT_IDS) {
  const doc = createDefaultDoc({ startSec: 0, endSec: 2, hook: "H" });
  doc.layers = doc.layers
    .filter((l) => l.type === "text")
    .map((l) => ({ ...l, anchor: "top" as const, yPct: 40, style: { ...l.style, fontId, sizePct: 10, outlinePct: 0 } }));
  const plan = compileRenderPlan(doc, []);
  const scene = resolveScene(plan);
  const line = scene.textBlocks[0].layout.lines[0];
  const fontSizePx = scene.textBlocks[0].layout.fontSizePx;
  const expectedBaseline = line.baselineY;
  const expectedCapTop = line.baselineY - FONTS[fontId].metrics.capHeightEm * fontSizePx;

  const ass = path.join(outDir, `${fontId}.ass`);
  const png = path.join(outDir, `${fontId}.png`);
  writeFileSync(ass, buildAssScript(plan, scene));
  spawnSync(ffmpegInstaller.path, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=1",
    "-vf", `ass=filename='${ass}':fontsdir='${path.resolve("public/fonts/clip-editor")}'`, "-frames:v", "1", png,
  ]);
  const py = spawnSync("python3", ["-c", `
from PIL import Image
im=Image.open("${png}").convert("L"); w,h=im.size; px=im.load()
rows=[y for y in range(h) if any(px[x,y]>128 for x in range(0,w,2))]
print(rows[0], rows[-1]+1)`]);
  const [top, bottom] = py.stdout.toString().trim().split(" ").map(Number);
  const dTop = top - expectedCapTop;
  const dBase = bottom - expectedBaseline;
  worst = Math.max(worst, Math.abs(dTop), Math.abs(dBase));
  console.log(
    `${fontId.padEnd(22)} capTop ${top} (exp ${expectedCapTop.toFixed(1)}, Δ${dTop.toFixed(1)})  baseline ${bottom} (exp ${expectedBaseline.toFixed(1)}, Δ${dBase.toFixed(1)})`,
  );
}
console.log(`worst deviation: ${worst.toFixed(1)}px at 192px font size`);
process.exit(worst > 4 ? 1 : 0);
