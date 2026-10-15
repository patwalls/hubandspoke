import { describe, it, expect } from "vitest";
import { arrowBendPoint, arrowEnds, arrowFromEnds, arrowSvg, bendFromPoint, snapAngle } from "./arrow";
import { arrow } from "./shared";
import { parseDesignDoc } from "./doc";
import { pageToSatoriTree } from "./render-tree";

describe("arrows", () => {
  it("ends → box → ends round-trips in every direction (the handles never drift)", () => {
    for (const [tail, head] of [
      [{ x: 100, y: 500 }, { x: 700, y: 500 }],
      [{ x: 700, y: 500 }, { x: 100, y: 500 }], // pointing left = 180°
      [{ x: 400, y: 900 }, { x: 900, y: 150 }], // up-right, like the Reddit cover
      [{ x: 300, y: 100 }, { x: 300, y: 800 }], // straight down
    ]) {
      const box = arrowFromEnds(tail, head, 0.25, 12);
      const ends = arrowEnds(box);
      expect(ends.tail.x).toBeCloseTo(tail.x, -0.5);
      expect(ends.tail.y).toBeCloseTo(tail.y, -0.5);
      expect(ends.head.x).toBeCloseTo(head.x, -0.5);
      expect(ends.head.y).toBeCloseTo(head.y, -0.5);
    }
  });

  it("the bend handle's own position reads back as the same bend; + bulges left of travel", () => {
    const el = arrow({ x: 200, y: 600 }, { x: 800, y: 600 }, { bend: 0.2 });
    const p = arrowBendPoint(el);
    // Travelling right, "left" is up the screen.
    expect(p.y).toBeLessThan(600);
    expect(bendFromPoint(el, p)).toBeCloseTo(0.2, 2);
    // Dragging the handle far past the limit clamps.
    expect(bendFromPoint(el, { x: 500, y: -5000 })).toBe(0.5);
  });

  it("the box is tall enough for the bulge, so the selection covers the curve", () => {
    const flat = arrowFromEnds({ x: 0, y: 0 }, { x: 600, y: 0 }, 0, 10);
    const curved = arrowFromEnds({ x: 0, y: 0 }, { x: 600, y: 0 }, 0.3, 10);
    expect(curved.h).toBeGreaterThanOrEqual(2 * 0.3 * 600);
    expect(flat.h).toBeLessThan(curved.h);
  });

  it("shift-snap keeps the length and lands on 15° steps", () => {
    const h = snapAngle({ x: 0, y: 0 }, { x: 100, y: 23 });
    expect(Math.hypot(h.x, h.y)).toBeCloseTo(Math.hypot(100, 23), 5);
    const steps = (Math.atan2(h.y, h.x) * 180) / Math.PI / 15;
    expect(steps).toBeCloseTo(Math.round(steps), 5);
  });

  it("draws one path per head and a curve only when bent", () => {
    const base = { w: 500, h: 80, color: "#22E07A", thickness: 10 };
    const straight = arrowSvg({ ...base, bend: 0, startHead: "none", endHead: "open" }).svg;
    expect(straight).not.toContain(" Q");
    expect(straight.match(/<path/g)).toHaveLength(2);
    const both = arrowSvg({ ...base, bend: 0.2, startHead: "filled", endHead: "filled" }).svg;
    expect(both).toContain(" Q");
    expect(both.match(/<path/g)).toHaveLength(3);
    expect(both.match(/Z"/g)).toHaveLength(2);
  });

  it("parses inside a doc and the exporter draws it as an image", () => {
    const el = arrow({ x: 300, y: 700 }, { x: 800, y: 300 }, { bend: -0.2, color: "#FF4500" });
    const parsed = parseDesignDoc({ version: 1, canvas: { width: 1080, height: 1080 }, template: "t", pages: [{ id: "p", background: "#000000", elements: [el] }] });
    expect(parsed.ok).toBe(true);
    const tree = JSON.stringify(pageToSatoriTree(parsed.ok ? parsed.doc.pages[0] : (null as never), { width: 1080, height: 1080 }, {}));
    expect(tree).toContain("data:image/svg+xml;base64,");
  });
});
