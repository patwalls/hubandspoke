import { describe, it, expect } from "vitest";
import { aspectOfCanvas, clipEditDocSchema, createDefaultDoc, setDocAspect, type ClipEditDoc, type ImageLayer } from "./doc";

const portrait = () => createDefaultDoc({ startSec: 100, endSec: 130, hook: "A short hook" });

describe("setDocAspect", () => {
  it("swaps the canvas and keeps the cut", () => {
    const doc = portrait();
    const next = setDocAspect(doc, "16:9");
    expect(next.canvas).toEqual({ ...doc.canvas, width: 1920, height: 1080 });
    expect(next.sections).toBe(doc.sections);
    expect(next.video).toBe(doc.video);
    expect(aspectOfCanvas(next.canvas)).toBe("16:9");
  });

  it("keeps text at its on-screen size (sizes are % of canvas height)", () => {
    const doc = portrait();
    const next = setDocAspect(doc, "16:9");
    for (const [before, after] of doc.layers.map((l, i) => [l, next.layers[i]] as const)) {
      if (before.type === "image" || after.type === "image") continue;
      expect(after.style.sizePct * 1080).toBeCloseTo(before.style.sizePct * 1920, -1);
      expect(after.xPct).toBe(before.xPct);
      expect(after.yPct).toBe(before.yPct);
    }
  });

  it("keeps an image at its on-screen width (widths are % of canvas width)", () => {
    const logo: ImageLayer = {
      id: "logo", type: "image", visible: true, xPct: 85, yPct: 5, anchor: "top",
      src: { kind: "url", url: "https://example.com/logo.png" },
      widthPct: 20, opacity: 1, sectionId: null,
    };
    const doc: ClipEditDoc = { ...portrait(), layers: [logo] };
    const next = setDocAspect(doc, "16:9");
    expect((next.layers[0] as ImageLayer).widthPct).toBeCloseTo(11.25);
  });

  it("round-trips back to portrait and stays a valid doc", () => {
    const doc = portrait();
    const back = setDocAspect(setDocAspect(doc, "16:9"), "9:16");
    expect(back.canvas).toEqual(doc.canvas);
    expect(clipEditDocSchema.safeParse(back).success).toBe(true);
  });

  it("is a no-op on the current aspect", () => {
    const doc = portrait();
    expect(setDocAspect(doc, "9:16")).toBe(doc);
  });
});
