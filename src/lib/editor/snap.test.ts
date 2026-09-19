import { describe, expect, it } from "vitest";
import { elementSnapTargets, snapMove, snapResize, snapValue } from "./snap";

const canvas = { width: 1080, height: 1080 };

describe("snap", () => {
  it("a moved box snaps its centre to the canvas centre and its edge to another element's edge", () => {
    const t = elementSnapTargets([{ x: 100, y: 100, w: 200, h: 50 }], canvas);
    const centred = snapMove({ x: 436, y: 500, w: 200, h: 100 }, t, 8); // centre at 536, canvas centre 540
    expect(centred.x).toBe(440);
    expect(centred.guides).toContainEqual({ axis: "x", at: 540, kind: "center" });
    const edge = snapMove({ x: 700, y: 153, w: 50, h: 50 }, t, 8); // top at 153, other's bottom at 150
    expect(edge.y).toBe(150);
    expect(edge.guides.find((g) => g.axis === "y")).toEqual({ axis: "y", at: 150, kind: "element" });
  });
  it("does nothing outside the threshold and prefers the canvas centre on a tie", () => {
    const t = elementSnapTargets([{ x: 0, y: 0, w: 1080, h: 1080 }], canvas); // element centre == canvas centre
    expect(snapMove({ x: 300, y: 300, w: 100, h: 100 }, t, 8)).toMatchObject({ x: 300, y: 300, guides: [] });
    const tie = snapMove({ x: 493, y: 300, w: 100, h: 100 }, t, 8);
    expect(tie.guides.find((g) => g.axis === "x")?.kind).toBe("center");
  });
  it("resizing snaps only the moving edge and keeps the minimum size", () => {
    const t = elementSnapTargets([], canvas, { margin: 40 });
    const r = snapResize({ x: 100, y: 100, w: 935, h: 200 }, "e", t, 8); // right edge 1035 → margin 1040
    expect(r.rect).toEqual({ x: 100, y: 100, w: 940, h: 200 });
    expect(r.guides).toEqual([{ axis: "x", at: 1040, kind: "edge" }]);
    const tiny = snapResize({ x: 36, y: 100, w: 22, h: 200 }, "w", t, 8); // left 36 → 40 would leave 18px
    expect(tiny.rect.w).toBe(22);
  });
  it("snapValue for one axis", () => {
    expect(snapValue(537, [{ at: 540, kind: "center" }], 8)).toEqual({ value: 540, guide: { axis: "y", at: 540, kind: "center" } });
    expect(snapValue(500, [{ at: 540, kind: "center" }], 8).guide).toBeNull();
  });
});
