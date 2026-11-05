import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "./doc";
import { retimeSectionInDoc } from "./sections";
import { momentInClip, stitchInMoment } from "./stitch";

// Clip body 100–130, with an intro pulled from 20–25.
const doc = () =>
  createDefaultDoc({ startSec: 100, endSec: 130, hook: "", introRanges: [{ startSec: 20, endSec: 25 }] });
const spans = (d: ReturnType<typeof doc>) => d.sections.map((s) => [s.startSec, s.endSec]);

describe("stitchInMoment", () => {
  it("plays a setup just before the body, after the intro — even when it's later in the recording", () => {
    const d = stitchInMoment(doc(), { role: "setup", startSec: 300, endSec: 310 });
    expect(spans(d)).toEqual([[20, 25], [300, 310], [100, 130]]);
  });

  it("plays a payoff last, even when it's earlier in the recording", () => {
    const d = stitchInMoment(doc(), { role: "payoff", startSec: 50, endSec: 58 });
    expect(spans(d)).toEqual([[20, 25], [100, 130], [50, 58]]);
  });

  it("puts a detail in recording order, but never ahead of the intro", () => {
    expect(spans(stitchInMoment(doc(), { role: "detail", startSec: 5, endSec: 12 }))).toEqual([
      [20, 25], [5, 12], [100, 130],
    ]);
    expect(spans(stitchInMoment(doc(), { role: "detail", startSec: 200, endSec: 210 }))).toEqual([
      [20, 25], [100, 130], [200, 210],
    ]);
  });

  it("extends the scene a moment touches instead of adding a scene", () => {
    const d = stitchInMoment(doc(), { role: "payoff", startSec: 130, endSec: 138 });
    expect(spans(d)).toEqual([[20, 25], [100, 138]]);
    expect(d.sections[1].id).toBe("body");
  });

  it("with no intro, a setup plays first", () => {
    const d = stitchInMoment(createDefaultDoc({ startSec: 100, endSec: 130, hook: "" }), {
      role: "setup", startSec: 300, endSec: 310,
    });
    expect(spans(d)).toEqual([[300, 310], [100, 130]]);
  });
});

describe("momentInClip", () => {
  it("is false before adding and true after", () => {
    const m = { role: "setup" as const, startSec: 300, endSec: 310 };
    expect(momentInClip(doc(), m)).toBe(false);
    expect(momentInClip(stitchInMoment(doc(), m), m)).toBe(true);
  });

  it("still counts a moment trimmed a little at the edge, not one mostly trimmed away", () => {
    const m = { role: "setup" as const, startSec: 300, endSec: 310 };
    const d = stitchInMoment(doc(), m);
    const id = d.sections[1].id;
    expect(momentInClip(retimeSectionInDoc(d, id, { startSec: 301, endSec: 310 }), m)).toBe(true);
    expect(momentInClip(retimeSectionInDoc(d, id, { startSec: 305, endSec: 310 }), m)).toBe(false);
  });

  it("counts a moment already inside the clip's own window", () => {
    expect(momentInClip(doc(), { startSec: 110, endSec: 115 })).toBe(true);
  });
});
