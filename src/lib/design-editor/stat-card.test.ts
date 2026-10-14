import { describe, it, expect } from "vitest";
import { defaultSeries, layoutStatCard, sparklinePaths, sparklineSvg } from "./stat-card";
import { statCard } from "./shared";
import { alphaBounds, fitCutoutBox } from "./cutout-geometry";
import { screenSampleTimes } from "./screen-times";

describe("layoutStatCard", () => {
  const el = statCard({ x: 100, y: 200, w: 540, h: 320 });

  it("lays label, value, sub and chart out inside the card, top to bottom, in card coordinates", () => {
    const l = layoutStatCard(el);
    expect(l.label.y).toBeLessThan(l.value.y);
    expect(l.value.y + l.value.h).toBeLessThanOrEqual(l.sub!.y + 1);
    expect(l.chart).not.toBeNull();
    expect(l.chart!.y).toBeGreaterThanOrEqual(l.sub!.y + l.sub!.h);
    expect(l.chart!.y + l.chart!.h).toBeLessThanOrEqual(el.h);
    for (const t of [l.label, l.value, l.sub!]) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(el.w);
    }
  });

  it("drops the sub line when empty and the chart when hidden", () => {
    const l = layoutStatCard({ ...el, sub: "", showChart: false });
    expect(l.sub).toBeNull();
    expect(l.chart).toBeNull();
  });

  it("uses the light palette for light cards", () => {
    expect(layoutStatCard({ ...el, theme: "light" }).bg).toBe("#FFFFFF");
    expect(layoutStatCard(el).bg).not.toBe("#FFFFFF");
  });
});

describe("sparkline", () => {
  it("normalises any scale into the box and closes the area to the bottom", () => {
    const { line, area } = sparklinePaths([1000, 3000, 2000, 9000], 400, 100);
    expect(line.startsWith("M0 ")).toBe(true);
    expect(line).toContain("L400 8");
    expect(area.endsWith("L400 100 L0 100 Z")).toBe(true);
  });

  it("survives a flat series", () => {
    expect(() => sparklinePaths([5, 5, 5], 100, 50)).not.toThrow();
  });

  it("renders an SVG with the accent colour and no text", () => {
    const svg = sparklineSvg(statCard({ x: 0, y: 0, w: 500, h: 300 }, { accent: "#FF00AA" }), 400, 120);
    expect(svg).toContain('stroke="#FF00AA"');
    expect(svg).not.toContain("<text");
  });
});

describe("defaultSeries", () => {
  it("is deterministic for a seed and ends on its peak", () => {
    const a = defaultSeries("$160,324");
    expect(a).toEqual(defaultSeries("$160,324"));
    expect(a).not.toEqual(defaultSeries("$4.5M"));
    expect(a[a.length - 1]).toBe(Math.max(...a));
    expect(a).toHaveLength(24);
  });
});

describe("alphaBounds", () => {
  it("finds the opaque box with padding, clamped to the picture", () => {
    const w = 10, h = 8;
    const alpha = new Uint8Array(w * h);
    alpha[3 * w + 4] = 255;
    alpha[5 * w + 6] = 200;
    expect(alphaBounds(alpha, w, h)).toEqual({ x: 4, y: 3, w: 3, h: 3 });
    expect(alphaBounds(alpha, w, h, 16, 10)).toEqual({ x: 0, y: 0, w: 10, h: 8 });
  });

  it("is null for a fully transparent mask", () => {
    expect(alphaBounds(new Uint8Array(20), 5, 4)).toBeNull();
  });
});

describe("fitCutoutBox", () => {
  const box = { x: 300, y: 60, w: 700, h: 1000 };

  it("fills the box's height at the cutout's aspect, bottom-aligned and centred", () => {
    expect(fitCutoutBox(box, { width: 500, height: 1000 })).toEqual({ x: 400, y: 60, w: 500, h: 1000 });
  });

  it("narrows to the box's width when the person is wider", () => {
    const r = fitCutoutBox(box, { width: 1000, height: 1000 });
    expect(r.w).toBe(700);
    expect(r.h).toBe(700);
    expect(r.y + r.h).toBe(box.y + box.h);
  });

  it("leaves the box alone without a size", () => {
    expect(fitCutoutBox(box, null)).toEqual(box);
  });
});

describe("screenSampleTimes", () => {
  it("samples every ~20s after the intro and caps the count", () => {
    const t = screenSampleTimes(600);
    expect(t[0]).toBe(8);
    expect(t[t.length - 1]).toBeLessThan(600);
    expect(t.length).toBeGreaterThan(25);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(screenSampleTimes(3600)).toHaveLength(60);
  });

  it("handles short videos", () => {
    expect(screenSampleTimes(0)).toEqual([]);
    expect(screenSampleTimes(15).length).toBeGreaterThanOrEqual(1);
  });
});
