import { describe, expect, it } from "vitest";
import { createDefaultDoc, type ClipEditDoc } from "./doc";
import { clipTrim, summarizeTrims, trimHabitsBlock, trimHabitsLine } from "./trim-habits";

const IDEA = { startSec: 100, endSec: 160 };
const doc = (): ClipEditDoc => structuredClone(createDefaultDoc({ startSec: 100, endSec: 160, hook: "h" }));
const body = (d: ClipEditDoc) => d.sections.find((s) => s.role === "body")!;
const cut = (d: ClipEditDoc, startSec: number, endSec: number) => {
  body(d).removals.push({ startSec, endSec, reason: "manual" });
  return d;
};

describe("clipTrim (what the editor cut off the AI window)", () => {
  it("an untouched clip has no trim", () => {
    expect(clipTrim(IDEA, doc())).toEqual({ headSec: 0, tailSec: 0 });
  });

  it("a removal at the start of the scene is a head cut; one at the end is a tail cut", () => {
    expect(clipTrim(IDEA, cut(cut(doc(), 100, 121), 145, 160))).toEqual({ headSec: 21, tailSec: 15 });
  });

  it("a cut in the middle is neither (that's a tangent, not a trim)", () => {
    expect(clipTrim(IDEA, cut(doc(), 120, 130))).toEqual({ headSec: 0, tailSec: 0 });
  });

  it("back-to-back cuts at the start add up, and moving the scene's own start counts too", () => {
    const d = cut(cut(doc(), 104, 110), 110.3, 118);
    body(d).startSec = 104;
    expect(clipTrim(IDEA, d)?.headSec).toBe(18);
  });

  it("widening the window is not a trim", () => {
    const d = doc();
    body(d).startSec = 90;
    body(d).endSec = 170;
    expect(clipTrim(IDEA, d)).toEqual({ headSec: 0, tailSec: 0 });
  });

  it("an uploaded scene is not the AI window; a stitched-in moment elsewhere doesn't count either", () => {
    const d = cut(doc(), 100, 110);
    d.sections.unshift({ id: "up", role: "intro", startSec: 0, endSec: 200, removals: [], mediaId: "m1" });
    d.sections.push({ id: "far", role: "body", startSec: 400, endSec: 412, removals: [] });
    expect(clipTrim(IDEA, d)).toEqual({ headSec: 10, tailSec: 0 });
  });

  it("a doc with no source scene over the window says nothing", () => {
    const d = doc();
    body(d).startSec = 300;
    body(d).endSec = 340;
    expect(clipTrim(IDEA, d)).toBeNull();
  });
});

describe("summarizeTrims + trimHabitsBlock (what the clip writer learns)", () => {
  const rows = (docs: ClipEditDoc[]) => docs.map((d) => ({ ...IDEA, doc: d }));

  it("too few clips, or editors who rarely trim, give no block (the prompt is unchanged)", () => {
    expect(summarizeTrims(rows([cut(doc(), 100, 120), cut(doc(), 100, 120)]))).toBeNull();
    expect(summarizeTrims(rows([cut(doc(), 100, 120), doc(), doc(), doc(), doc(), doc()]))).toBeNull();
    expect(trimHabitsBlock(null)).toBeNull();
  });

  it("slivers under 3s are edge tidies, not trims", () => {
    expect(summarizeTrims(rows([1, 2, 3, 4, 5].map(() => cut(doc(), 100, 101.5))))).toBeNull();
  });

  it("counts head and tail cuts with their medians, and the block names only the end editors trim", () => {
    const s = summarizeTrims(rows([cut(doc(), 100, 110), cut(doc(), 100, 130), cut(doc(), 100, 120), doc(), doc(), doc()]));
    expect(s).toEqual({ clips: 6, headCut: 3, medianHeadSec: 20, tailCut: 0, medianTailSec: 0 });
    const block = trimHabitsBlock(s)!;
    expect(block).toContain("of the last 6 edited clips, editors cut the opening on 3 (median 20s)");
    expect(block).toContain("tightStartSec up to ~20s later");
    expect(block).not.toContain("tightEndSec");
  });

  it("both ends trimmed → both moves", () => {
    const s = summarizeTrims(rows([1, 2, 3, 4, 5].map(() => cut(cut(doc(), 100, 107), 150, 160))));
    const block = trimHabitsBlock(s)!;
    expect(block).toContain("cut the opening on 5 (median 7s) and cut the ending on 5 (median 10s)");
    expect(block).toContain("tightEndSec up to ~10s earlier");
  });
});

describe("trimHabitsLine (the format page's line, clip-trim M2)", () => {
  const S = { clips: 20, headCut: 9, medianHeadSec: 7, tailCut: 2, medianTailSec: 4 };

  it("names only the end editors trim often enough for the writer to learn it", () => {
    expect(trimHabitsLine(S)).toEqual({ lead: "Editors cut the opening on", counts: "9 of 20 clips (~7s)" });
    expect(trimHabitsLine({ ...S, headCut: 2, tailCut: 6 })).toEqual({ lead: "Editors cut the ending on", counts: "6 of 20 clips (~4s)" });
  });

  it("both ends → one line with both", () => {
    expect(trimHabitsLine({ ...S, tailCut: 5 })).toEqual({ lead: "Editors cut the opening on", counts: "9 of 20 clips (~7s) and the ending on 5 (~4s)" });
  });

  it("no habit → no line (nothing on the page)", () => {
    expect(trimHabitsLine(null)).toBeNull();
    expect(trimHabitsLine({ ...S, headCut: 4, tailCut: 4 })).toBeNull();
  });
});
