import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "./doc";
import { compileRenderPlan } from "./plan";
import { addRemoval } from "./removals";
import { deleteSection, includeRange, splitSectionAt } from "./sections";
import { edgeAfter, edgeBefore, pieceAt, rulerLabel, rulerStep, timelinePieces } from "./timeline";

const doc = () => createDefaultDoc({ startSec: 100, endSec: 110, hook: "h" });

describe("splitSectionAt (blade)", () => {
  it("cuts a section in two that still play back to back", () => {
    const d = splitSectionAt(doc(), "body", 104);
    expect(d.sections.map((s) => [s.id === "body", s.startSec, s.endSec])).toEqual([[true, 100, 104], [false, 104, 110]]);
    const plan = compileRenderPlan(d, []);
    expect(plan.durationSec).toBeCloseTo(10);
    expect(plan.segments.map((s) => [s.sourceStartSec, s.sourceEndSec])).toEqual([[100, 104], [104, 110]]);
  });

  it("splits removals with the section", () => {
    const d0 = doc();
    d0.sections[0] = addRemoval(d0.sections[0], { startSec: 103, endSec: 106 }, "manual");
    const d = splitSectionAt(d0, "body", 104);
    expect(d.sections[0].removals).toEqual([{ startSec: 103, endSec: 104, reason: "manual" }]);
    expect(d.sections[1].removals).toEqual([{ startSec: 104, endSec: 106, reason: "manual" }]);
  });

  it("ignores a cut at (or right next to) an edge, or in an unknown section", () => {
    const d = doc();
    expect(splitSectionAt(d, "body", 100.05)).toBe(d);
    expect(splitSectionAt(d, "body", 109.95)).toBe(d);
    expect(splitSectionAt(d, "nope", 104)).toBe(d);
  });
});

describe("deleteSection", () => {
  it("removes a piece, but never the last one", () => {
    const d = splitSectionAt(doc(), "body", 104);
    const right = d.sections[1].id;
    expect(deleteSection(d, right).sections.map((s) => s.id)).toEqual(["body"]);
    const one = doc();
    expect(deleteSection(one, "body")).toBe(one);
  });
});

describe("timelinePieces", () => {
  it("one piece per section in play order, removals as seams", () => {
    let d = includeRange(doc(), { startSec: 10, endSec: 13 }); // 10–13 then body
    d = { ...d, sections: d.sections.map((s) => (s.id === "body" ? addRemoval(s, { startSec: 104, endSec: 105 }, "manual") : s)) };
    const pieces = timelinePieces(compileRenderPlan(d, []));
    expect(pieces.map((p) => [p.index, p.outStartSec, p.outEndSec])).toEqual([[1, 0, 3], [2, 3, 12]]);
    expect(pieces[1].seams).toEqual([7]);
    expect(pieceAt(pieces, 2.9)?.index).toBe(1);
    expect(pieceAt(pieces, 3)?.index).toBe(2);
    expect(pieceAt(pieces, 99)?.index).toBe(2);
    expect(edgeBefore(pieces, 8)).toBe(7);
    expect(edgeBefore(pieces, 7)).toBe(3);
    expect(edgeAfter(pieces, 3, 12)).toBe(7);
    expect(edgeAfter(pieces, 7, 12)).toBe(12);
  });
});

describe("ruler", () => {
  it("picks a step that keeps labels apart", () => {
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(20)).toBe(5);
    expect(rulerStep(1000)).toBe(0.1);
  });
  it("labels whole seconds, and tenths when zoomed in", () => {
    expect(rulerLabel(65, 1)).toBe("1:05");
    expect(rulerLabel(5.5, 0.5)).toBe("0:05.5");
  });
});
