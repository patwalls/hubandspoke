import { describe, it, expect } from "vitest";
import { createDefaultDoc, type ClipEditDoc, type Section } from "./doc";
import { addRemoval } from "./removals";
import { formatSourceParts, sourceParts } from "./source-parts";

function docWith(sections: Section[]): ClipEditDoc {
  const doc = createDefaultDoc({ startSec: 0, endSec: 10, hook: "h" });
  return { ...doc, sections };
}

const sec = (id: string, startSec: number, endSec: number, extra: Partial<Section> = {}): Section => ({
  id,
  role: "body",
  startSec,
  endSec,
  removals: [],
  ...extra,
});

describe("sourceParts", () => {
  it("a big manual cut inside one scene splits it into two parts", () => {
    // The hull 01:38–07:12 read as a 5½-minute clip when ~38 s played.
    const s = addRemoval(sec("a", 98, 432), { startSec: 112, endSec: 408 }, "manual");
    expect(formatSourceParts(sourceParts(docWith([s])))).toBe("01:38–01:52 + 06:48–07:12");
  });

  it("fillers and pauses don't split a part", () => {
    let s = sec("a", 100, 130);
    s = addRemoval(s, { startSec: 105, endSec: 105.4 }, "filler");
    s = addRemoval(s, { startSec: 118, endSec: 119.5 }, "silence");
    expect(formatSourceParts(sourceParts(docWith([s])))).toBe("01:40–02:10");
  });

  it("lists parts in play order — an intro pulled to the top reads first", () => {
    const parts = sourceParts(docWith([sec("intro", 5, 15, { role: "intro" }), sec("b", 300, 340)]));
    expect(formatSourceParts(parts)).toBe("00:05–00:15 + 05:00–05:40");
  });

  it("a scene split on the timeline (back to back) still reads as one part", () => {
    expect(formatSourceParts(sourceParts(docWith([sec("a", 60, 70), sec("b", 70, 90)])))).toBe("01:00–01:30");
  });

  it("a later scene played before an earlier one is not merged backwards", () => {
    expect(formatSourceParts(sourceParts(docWith([sec("a", 70, 90), sec("b", 60, 70)])))).toBe(
      "01:10–01:30 + 01:00–01:10",
    );
  });

  it("skips uploaded clips (their times aren't the source's)", () => {
    const parts = sourceParts(docWith([sec("up", 0, 8, { mediaId: "m1" }), sec("a", 200, 230)]));
    expect(formatSourceParts(parts)).toBe("03:20–03:50");
  });

  it("a sliver left between two cuts (a tenth of a second) isn't listed", () => {
    // Prod, 11-24: a removal stored as float32 (1502.3999938964844) left 0.1 s
    // kept at 25:02 (a 3-frame flash); the comment said "25:02–25:02 + …".
    const a = addRemoval(sec("a", 1497.26, 1502.303), { startSec: 1497.260009765625, endSec: 1502.303 }, "manual");
    const b = addRemoval(sec("b", 1502.303, 1516.703), { startSec: 1502.3999938964844, endSec: 1514.260009765625 }, "manual");
    const c = sec("c", 1516.703, 1583);
    expect(formatSourceParts(sourceParts(docWith([a, b, c])))).toBe("25:14–26:23");
  });

  it("a clip that is only slivers still says where it is", () => {
    expect(formatSourceParts(sourceParts(docWith([sec("a", 62, 62.5)])))).toBe("01:02–01:02");
  });

  it("collapses past four parts into '+ N more'", () => {
    const many = [0, 100, 200, 300, 400, 500].map((t, i) => sec(`s${i}`, t, t + 10));
    expect(formatSourceParts(sourceParts(docWith(many)))).toBe(
      "00:00–00:10 + 01:40–01:50 + 03:20–03:30 + 3 more",
    );
  });
});
