/**
 * Dev smoke test for the clip-editor export path — renders a synthetic source
 * through the REAL plan → ASS → ffmpeg pipeline, no DB or S3 involved.
 *
 *   npx tsx scripts/clip-editor-render-smoke.ts [source.mp4] [outDir]
 *
 * With no source it synthesizes one (test pattern + a beep every second, so
 * cut accuracy and A/V sync are visible/audible in the output).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { createDefaultDoc } from "../src/lib/clip-editor/doc";
import { compileRenderPlan } from "../src/lib/clip-editor/plan";
import { resolveScene } from "../src/lib/clip-editor/scene";
import { buildAssScript } from "../src/lib/clip-editor/ass";
import { buildFilterGraph, buildRenderArgs } from "../src/lib/clip-editor/ffmpeg-args";
import { addRemoval } from "../src/lib/clip-editor/removals";
import type { EditorWord } from "../src/lib/clip-editor/words";

const outDir = path.resolve(process.argv[3] ?? "/tmp/clip-editor-smoke");
mkdirSync(outDir, { recursive: true });
let source = process.argv[2];
const ffmpeg = ffmpegInstaller.path;

if (!source) {
  source = path.join(outDir, "source.mp4");
  const r = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=30",
    "-f", "lavfi", "-i", "sine=f=880:b=1:d=30",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}

const doc = createDefaultDoc({
  startSec: 10,
  endSec: 20,
  hook: "This founder makes $40K/month from one boring app",
  introRanges: [{ startSec: 2, endSec: 4 }],
});
const body = doc.sections.findIndex((s) => s.role === "body");
doc.sections[body] = addRemoval(doc.sections[body], { startSec: 12, endSec: 13.5 }, "filler");
doc.sections[body] = addRemoval(doc.sections[body], { startSec: 16.2, endSec: 17 }, "silence");

const texts = "so basically I built this thing in a weekend and it just kept growing every single month".split(" ");
const words: EditorWord[] = texts.map((text, i) => ({
  index: i, text, startSec: 10 + i * 0.6, endSec: 10 + i * 0.6 + 0.5,
}));
words.push({ index: 99, text: "intro", startSec: 2.2, endSec: 2.8 }, { index: 100, text: "line", startSec: 2.9, endSec: 3.6 });

const plan = compileRenderPlan(doc, words);
const scene = resolveScene(plan);
const assPath = path.join(outDir, "overlay.ass");
const filterPath = path.join(outDir, "graph.txt");
const outputPath = path.join(outDir, "out.mp4");
writeFileSync(assPath, buildAssScript(plan, scene));
writeFileSync(filterPath, buildFilterGraph(plan, {
  assPath,
  fontsDir: path.resolve("public/fonts/clip-editor"),
}));
const argv = buildRenderArgs({ plan, input: source, filterScriptPath: filterPath, outputPath });
console.log(`plan: ${plan.segments.length} segments, ${plan.durationSec.toFixed(2)}s, ${plan.captions?.cues.length ?? 0} cues`);
const started = Date.now();
const r = spawnSync(ffmpeg, argv, { stdio: ["ignore", "ignore", "inherit"] });
console.log(`ffmpeg exit=${r.status} in ${((Date.now() - started) / 1000).toFixed(1)}s → ${outputPath}`);
process.exit(r.status ?? 1);
