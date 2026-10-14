import { describe, it, expect } from "vitest";
import { DEFAULT_CROP } from "./doc";
import { coverGeometry } from "./layout";
import { subjectLayerGeometry } from "./cutout-geometry";

/** Canvas px of a source-picture point, drawn the way the stage draws `el`. */
function sourcePointOnCanvas(el: { x: number; y: number; w: number; h: number; fit: "cover" | "contain"; crop: typeof DEFAULT_CROP }, natural: { width: number; height: number }, u: number, v: number) {
  const g = coverGeometry(natural, el, el.crop, el.fit);
  return { x: el.x + g.left + u * g.width, y: el.y + g.top + v * g.height };
}

describe("subjectLayerGeometry (split into layers)", () => {
  const natural = { width: 1920, height: 1080 };
  const bounds = { x: 0.4, y: 0.2, w: 0.2, h: 0.8 };

  it("a fully visible subject is a contain box exactly over the person", () => {
    const el = { x: 100, y: 50, w: 960, h: 540, fit: "contain" as const, crop: DEFAULT_CROP };
    const g = subjectLayerGeometry(el, natural, bounds)!;
    const tl = sourcePointOnCanvas(el, natural, bounds.x, bounds.y);
    expect(g.fit).toBe("contain");
    expect(g.x).toBe(Math.round(tl.x));
    expect(g.y).toBe(Math.round(tl.y));
    expect(g.w).toBe(192);
    expect(g.h).toBe(432);
  });

  it("a subject the cover crop cuts off is clipped to the frame, at the same scale and position", () => {
    // Square frame over a 16:9 picture, zoomed and panned: the person runs off the top.
    const el = { x: 0, y: 0, w: 1080, h: 1080, fit: "cover" as const, crop: { x: 0.5, y: 0.75, zoom: 1.5 } };
    const g = subjectLayerGeometry(el, natural, bounds)!;
    expect(g.fit).toBe("cover");
    expect(g.y).toBe(0);
    expect(g.x + g.w).toBeLessThanOrEqual(1080);
    expect(g.y + g.h).toBeLessThanOrEqual(1080);
    // Drawing the trimmed cutout in that box puts its pixels where the picture had them.
    const cut = { width: 384, height: 864 };
    const drawn = coverGeometry(cut, g, g.crop, "cover");
    const want = sourcePointOnCanvas(el, natural, bounds.x, bounds.y);
    expect(g.x + drawn.left).toBeCloseTo(want.x, 0);
    expect(g.y + drawn.top).toBeCloseTo(want.y, 0);
    const full = coverGeometry(natural, el, el.crop, "cover");
    expect(drawn.width).toBeCloseTo(bounds.w * full.width, 0);
  });

  it("a tilted picture's subject keeps the tilt and orbits the picture's centre", () => {
    const el = { x: 0, y: 0, w: 1000, h: 1000, fit: "contain" as const, crop: DEFAULT_CROP, rotation: 90 };
    const sq = { width: 1000, height: 1000 };
    // Subject in the top-right quadrant → after a 90° turn it sits bottom-right.
    const g = subjectLayerGeometry(el, sq, { x: 0.6, y: 0.1, w: 0.2, h: 0.2 })!;
    expect(g.rotation).toBe(90);
    expect(g.x + g.w / 2).toBeCloseTo(800, 0);
    expect(g.y + g.h / 2).toBeCloseTo(700, 0);
  });

  it("null when the subject is entirely out of frame", () => {
    const el = { x: 0, y: 0, w: 500, h: 500, fit: "cover" as const, crop: { x: 0, y: 0.5, zoom: 2 } };
    expect(subjectLayerGeometry(el, natural, { x: 0.85, y: 0.1, w: 0.1, h: 0.5 })).toBeNull();
  });
});
