import { describe, expect, it } from "vitest";
import { applyLook, clipLookSchema, createDefaultDoc, lookFromDoc, type CaptionsLayer } from "./doc";

describe("clip look (a format's template for new edits)", () => {
  it("captures the style half of a doc and applies it to another clip without touching the cut or the hook text", () => {
    const styled = createDefaultDoc({ startSec: 10, endSec: 40, hook: "A styled clip" });
    styled.canvas.background = "#101010";
    styled.video = { ...styled.video, fit: "contain", scalePct: 90, radiusPct: 6 };
    const caps = styled.layers.find((l): l is CaptionsLayer => l.type === "captions")!;
    caps.style = { ...caps.style, fontId: "bangers", color: "#FFE14D" };
    caps.maxWordsPerCue = 2;
    const look = lookFromDoc(styled);
    expect(clipLookSchema.safeParse(JSON.parse(JSON.stringify(look))).success).toBe(true);
    expect(look).not.toHaveProperty("sections");

    const fresh = createDefaultDoc({ startSec: 100, endSec: 130, hook: "A completely different and much longer hook for the next clip idea" });
    const out = applyLook(fresh, look);
    expect(out.sections).toEqual(fresh.sections);
    expect(out.canvas.background).toBe("#101010");
    expect(out.video).toEqual(styled.video);
    const outCaps = out.layers.find((l): l is CaptionsLayer => l.type === "captions")!;
    expect(outCaps.style.fontId).toBe("bangers");
    expect(outCaps.maxWordsPerCue).toBe(2);
    const hook = out.layers.find((l) => l.type === "text" && l.role === "hook");
    expect(hook && hook.type === "text" ? hook.text : null).toBe("A completely different and much longer hook for the next clip idea");
    // The look's hook size is a ceiling; a longer hook is fitted down, never up.
    expect(hook && hook.type === "text" ? hook.style.sizePct : 99).toBeLessThanOrEqual(look.layers.find((l) => l.type === "text")!.type === "text" ? (look.layers.find((l) => l.type === "text") as { style: { sizePct: number } }).style.sizePct : 0);
  });
});

import { layoutTextBlock } from "./layout";
import { buildAssScript } from "./ass";
import { compileRenderPlan } from "./plan";
import { resolveScene } from "./scene";

describe("text alignment", () => {
  const base = { words: [{ text: "short", ref: 0 }, { text: "a", ref: 1 }, { text: "much", ref: 2 }, { text: "longer", ref: 3 }, { text: "line", ref: 4 }], canvas: { width: 1080, height: 1920 }, xPct: 50, yPct: 30, anchor: "bottom" as const, widthPct: 80, balance: false };
  const style = { fontId: "montserrat-extrabold" as const, sizePct: 6, color: "#FFF", outlinePct: 0, outlineColor: "#000", uppercase: false, shadow: null, box: null };
  it("left/right lines share an edge with the wrap box; centre lines are centred on xPct", () => {
    const left = layoutTextBlock({ ...base, style: { ...style, align: "left" } });
    expect(left.lines.length).toBeGreaterThan(1);
    expect(new Set(left.lines.map((l) => Math.round(l.x))).size).toBe(1);
    expect(Math.round(left.lines[0].x)).toBe(540 - 432); // box left
    const right = layoutTextBlock({ ...base, style: { ...style, align: "right" } });
    expect(new Set(right.lines.map((l) => Math.round(l.x + l.widthPx))).size).toBe(1);
    expect(Math.round(right.lines[0].x + right.lines[0].widthPx)).toBe(540 + 432);
    const centre = layoutTextBlock({ ...base, style: { ...style, align: "center" } });
    for (const l of centre.lines) expect(Math.round(l.x + l.widthPx / 2)).toBe(540);
    expect(centre.right - centre.left).toBeCloseTo(centre.widthPx, 3);
  });
  it("the ASS script anchors left-aligned lines with an7 at the line's left edge", () => {
    const doc = createDefaultDoc({ startSec: 0, endSec: 10, hook: "a hook that wraps onto two lines for sure" });
    const hook = doc.layers.find((l) => l.type === "text")!;
    if (hook.type === "text") hook.style.align = "left";
    const plan = compileRenderPlan(doc, []);
    const ass = buildAssScript(plan, resolveScene(plan));
    expect(ass).toContain("{\\an7\\q2\\pos(");
    expect(ass).not.toContain("{\\an8\\q2\\pos(");
  });
});

describe("caption effects in the ASS export", () => {
  it("emits a box drawing and a blurred shadow copy under each line", () => {
    const doc = createDefaultDoc({ startSec: 0, endSec: 6, hook: "hello there" });
    const caps = doc.layers.find((l): l is CaptionsLayer => l.type === "captions")!;
    caps.style = { ...caps.style, outlinePct: 0, shadow: { color: "#000000", alpha: 0.5, blurPct: 10, xPct: 0, yPct: 5 }, box: { color: "#112233", alpha: 0.7, radiusPct: 20, padPct: 20 } };
    const words = ["we", "built", "it"].map((text, i) => ({ index: i, text, startSec: i, endSec: i + 0.8 }));
    const plan = compileRenderPlan(doc, words);
    const ass = buildAssScript(plan, resolveScene(plan));
    expect(ass).toMatch(/\\p1}m [\d.]+ 0 l /); // the box path
    expect(ass).toContain("\\c&H332211&"); // box colour (BGR)
    expect(ass).toMatch(/\\blur[\d.]+}WE/); // shadow copy of the cue
    // Box (3) and shadow (4) sit under the caption text (5); the hook is on 10.
    const layers = [...ass.matchAll(/^Dialogue: (\d+),/gm)].map((m) => Number(m[1]));
    expect(new Set(layers)).toEqual(new Set([3, 4, 5, 10]));
  });
});
