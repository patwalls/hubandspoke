import { describe, it, expect } from "vitest";
import type { VideoPlacement } from "./doc";
import { boxOverflows, centreVideoAt, resolveVideoBox } from "./video-box";

/** resolveVideoBox exactly as it was before zoom existed (scale ≤ 100). */
function legacy(canvas: { width: number; height: number }, video: VideoPlacement, source: { width: number; height: number }) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const { width: W, height: H } = canvas;
  const a = source.width / source.height;
  const wide = a > W / H;
  if (video.fit === "cover") {
    const width = wide ? even(H * a) : W;
    const height = wide ? H : even(W / a);
    return { x: -Math.round(((width - W) * video.panXPct) / 100), y: -Math.round((height - H) / 2), width, height, radius: 0 };
  }
  const s = video.scalePct / 100;
  const width = even((wide ? W : H * a) * s);
  const height = even((wide ? W / a : H) * s);
  const y = Math.round(Math.max(0, Math.min(H - height, (H * video.yPct) / 100 - height / 2)));
  return { x: Math.round((W - width) / 2), y, width, height, radius: Math.round((video.radiusPct / 100) * Math.min(width, height)) };
}

const vertical = { width: 1080, height: 1920 };
const wideSrc = { width: 1920, height: 1080 };
const base: VideoPlacement = { fit: "contain", yPct: 50, panXPct: 50, panYPct: 50, scalePct: 100, radiusPct: 0 };
const same = (a: { x: number; y: number; width: number; height: number; radius: number }, b: typeof a) =>
  expect([a.x + 0, a.y + 0, a.width, a.height, a.radius]).toEqual([b.x + 0, b.y + 0, b.width, b.height, b.radius]);

describe("resolveVideoBox — existing clips render exactly as before", () => {
  it("matches the pre-zoom geometry for every setting it allowed", () => {
    for (const canvas of [vertical, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }])
      for (const source of [wideSrc, { width: 1080, height: 1920 }, { width: 1440, height: 1080 }])
        for (const fit of ["contain", "cover"] as const)
          for (const scalePct of [30, 61, 90, 100])
            for (const yPct of [0, 33, 50, 100])
              for (const panXPct of [0, 25, 50, 100])
                for (const radiusPct of [0, 10]) {
                  const v = { ...base, fit, scalePct, yPct, panXPct, radiusPct };
                  same(resolveVideoBox(canvas, v, source), legacy(canvas, v, source));
                }
  });
});

describe("resolveVideoBox — zoom past 100", () => {
  it("contain at 200% on a vertical canvas overflows sideways, centred by default", () => {
    const box = resolveVideoBox(vertical, { ...base, scalePct: 200 }, wideSrc);
    expect(box).toMatchObject({ width: 2160, height: 1216, x: -540, radius: 0 });
    expect(boxOverflows(vertical, box)).toBe(true);
  });

  it("pans across the overflow with panXPct, and vertically with yPct once taller than the canvas", () => {
    expect(resolveVideoBox(vertical, { ...base, scalePct: 200, panXPct: 0 }, wideSrc).x).toBe(0);
    expect(resolveVideoBox(vertical, { ...base, scalePct: 200, panXPct: 100 }, wideSrc).x).toBe(1080 - 2160);
    const tall = resolveVideoBox(vertical, { ...base, scalePct: 400, yPct: 0 }, wideSrc);
    expect(tall.height).toBeGreaterThan(1920);
    expect(tall.y).toBe(0);
    expect(resolveVideoBox(vertical, { ...base, scalePct: 400, yPct: 100 }, wideSrc).y).toBe(1920 - tall.height);
  });

  it("cover zooms past fill and pans vertically with panYPct; below 100 it still fills", () => {
    const fill = resolveVideoBox(vertical, { ...base, fit: "cover" }, wideSrc);
    expect(resolveVideoBox(vertical, { ...base, fit: "cover", scalePct: 60 }, wideSrc)).toEqual(fill);
    const zoomed = resolveVideoBox(vertical, { ...base, fit: "cover", scalePct: 150, panYPct: 0 }, wideSrc);
    expect(zoomed.height).toBe(2880);
    expect(zoomed.y).toBe(0);
  });

  it("drops rounded corners once the video spills past the canvas", () => {
    expect(resolveVideoBox(vertical, { ...base, scalePct: 150, radiusPct: 20 }, wideSrc).radius).toBe(0);
    expect(boxOverflows(vertical, resolveVideoBox(vertical, { ...base, scalePct: 80 }, wideSrc))).toBe(false);
  });
});

describe("centreVideoAt", () => {
  const centre = (v: VideoPlacement) => {
    const b = resolveVideoBox(vertical, v, wideSrc);
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  it("round-trips a zoomed video's centre", () => {
    const v = { ...base, scalePct: 250 };
    const moved = { ...v, ...centreVideoAt(vertical, v, wideSrc, 900, 700) };
    const [cx, cy] = centre(moved);
    expect(cx).toBeCloseTo(900, -1);
    expect(cy).toBeCloseTo(700, -1);
  });
  it("keeps a contained video centred across, moving only up/down", () => {
    const patch = centreVideoAt(vertical, base, wideSrc, 100, 400);
    expect(patch.panXPct).toBeUndefined();
    expect(centre({ ...base, ...patch })[1]).toBeCloseTo(400, -1);
  });
});
