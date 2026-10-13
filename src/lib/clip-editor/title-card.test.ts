import { describe, it, expect } from "vitest";
import { buildAssScript } from "./ass";
import { createDefaultDoc, createImageLayer, createTextElement } from "./doc";
import { buildFilterGraph } from "./ffmpeg-args";
import { compileRenderPlan } from "./plan";
import { resolveScene } from "./scene";
import { splitSectionAt } from "./sections";

const canvas = { width: 1080, height: 1920 };
// 100–110, split at 104: scene 1 plays 0–4s, scene 2 plays 4–10s.
const twoScenes = () => splitSectionAt(createDefaultDoc({ startSec: 100, endSec: 110, hook: "" }), "body", 104);

const dialogues = (ass: string, style: string) =>
  ass.split("\n").filter((l) => l.startsWith("Dialogue:") && l.includes(`,${style},`));

describe("title cards (scene-scoped text)", () => {
  it("a title shows only while its scene plays — preview window and export agree", () => {
    const d = twoScenes();
    const scene2 = d.sections[1].id;
    const title = createTextElement({ kind: "title", canvas, sectionId: scene2 });
    d.layers = [...d.layers.filter((l) => l.type !== "text"), title];
    const plan = compileRenderPlan(d, []);
    const scene = resolveScene(plan);
    const block = scene.textBlocks.find((b) => b.layer.id === title.id)!;
    expect(block.window).toEqual({ startSec: 4, endSec: 10 });
    const lines = dialogues(buildAssScript(plan, scene), `Text${scene.textBlocks.indexOf(block)}`);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^Dialogue: \d+,0:00:04\.00,0:00:10\.00,/);
  });

  it("a title card draws ONE box behind the whole text, not one per line", () => {
    const d = twoScenes();
    const title = { ...createTextElement({ kind: "title", canvas, sectionId: d.sections[0].id }), text: "Last 30 days. Your new real-time web search, in one place." };
    d.layers = [title];
    const plan = compileRenderPlan(d, []);
    const scene = resolveScene(plan);
    expect(scene.textBlocks[0].layout.lines.length).toBeGreaterThan(1);
    const drawings = dialogues(buildAssScript(plan, scene), "Text0").filter((l) => l.includes("\\p1"));
    expect(drawings).toHaveLength(1);
  });

  it("every element follows the picked scene, like framing — none picked = whole clip", () => {
    const d = twoScenes();
    for (const kind of ["text", "subtitle", "title"] as const) {
      expect(createTextElement({ kind, canvas, sectionId: d.sections[1].id }).sectionId).toBe(d.sections[1].id);
      expect(createTextElement({ kind, canvas, sectionId: null }).sectionId).toBeNull();
    }
  });

  it("a scene's logo is overlaid only during that scene in the export", () => {
    const d = twoScenes();
    d.layers = [{ ...createImageLayer({ src: { kind: "asset", path: "/watermarks/x.png" }, canvas }), sectionId: d.sections[1].id }];
    const g = buildFilterGraph(compileRenderPlan(d, []), { assPath: null, fontsDir: "/f", sourceSize: { width: 1920, height: 1080 } });
    expect(g).toContain("enable='between(t,4.000,10.000)'");
  });

  it("whole-clip text spans the clip; a title whose scene was deleted never shows", () => {
    const d = twoScenes();
    const text = createTextElement({ kind: "text", canvas, sectionId: null });
    const orphan = createTextElement({ kind: "title", canvas, sectionId: "gone" });
    d.layers = [text, orphan];
    const plan = compileRenderPlan(d, []);
    const scene = resolveScene(plan);
    expect(scene.textBlocks[0].window).toBeNull();
    const ass = buildAssScript(plan, scene);
    expect(dialogues(ass, "Text0").length).toBeGreaterThan(0);
    expect(dialogues(ass, "Text1")).toHaveLength(0);
  });
});
