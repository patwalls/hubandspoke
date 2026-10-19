import { describe, it, expect } from "vitest";
import { createDefaultDoc, type ClipEditDoc } from "./doc";
import { compileRenderPlan } from "./plan";
import { copyPieces, includeRange, pastePieces, primarySourceSections, retimeSectionInDoc, splitSectionAt } from "./sections";
import { buildTranscriptView } from "./transcript-view";
import { addRemoval } from "./removals";
import type { EditorWord } from "./words";

// 100–110 split at 104 → A(100–104) B(104–110). Word i spans i … i+0.8.
const twoScenes = () => splitSectionAt(createDefaultDoc({ startSec: 100, endSec: 110, hook: "" }), "body", 104);
const spans = (d: ClipEditDoc) => d.sections.map((s) => [s.startSec, s.endSec]);
const words: EditorWord[] = Array.from({ length: 120 }, (_, i) => ({ index: i, text: `w${i}`, startSec: i, endSec: i + 0.8 }));
const shown = (d: ClipEditDoc) =>
  buildTranscriptView(d, words).tokens.flatMap((t) => (t.kind === "word" ? [t.text] : t.kind === "marker" ? [`[${t.index}]`] : []));

/** Copy A's 101–103 and paste it between w107 and w108 (inside B). */
const pastedIntoB = () => {
  const d = twoScenes();
  const pieces = copyPieces(d, [{ sectionId: d.sections[0].id, range: { startSec: 101, endSec: 103 } }]);
  return pastePieces(d, pieces, { sectionId: d.sections[1].id, atSec: 108 });
};

describe("copy / paste text (with its footage)", () => {
  it("pastes mid-scene by splitting it there; the original stays", () => {
    const d = pastedIntoB();
    expect(spans(d)).toEqual([[100, 104], [104, 108], [101, 103], [108, 110]]);
    const plan = compileRenderPlan(d, []);
    expect(plan.segments.map((s) => [s.sourceStartSec, s.sourceEndSec])).toEqual([[100, 104], [104, 108], [101, 103], [108, 110]]);
  });

  it("pastes before / after a scene without splitting it", () => {
    const d = twoScenes();
    const pieces = copyPieces(d, [{ sectionId: d.sections[1].id, range: { startSec: 105, endSec: 106 } }]);
    expect(spans(pastePieces(d, pieces, { sectionId: d.sections[0].id, atSec: Number.NEGATIVE_INFINITY }))).toEqual([[105, 106], [100, 104], [104, 110]]);
    expect(spans(pastePieces(d, pieces, { sectionId: d.sections[1].id, atSec: Number.POSITIVE_INFINITY }))).toEqual([[100, 104], [104, 110], [105, 106]]);
  });

  it("copies the cuts inside the copied words, and only those", () => {
    let d = twoScenes();
    d = { ...d, sections: d.sections.map((s, i) => (i === 0 ? addRemoval(addRemoval(s, { startSec: 100.2, endSec: 100.5 }, "filler"), { startSec: 102.2, endSec: 102.5 }, "filler") : s)) };
    const [piece] = copyPieces(d, [{ sectionId: d.sections[0].id, range: { startSec: 101, endSec: 103 } }]);
    expect(piece.removals).toEqual([{ startSec: 102.2, endSec: 102.5, reason: "filler" }]);
  });

  it("refuses to go past 20 scenes", () => {
    let d = createDefaultDoc({ startSec: 0, endSec: 40, hook: "" });
    for (let t = 2; t < 40; t += 2) d = splitSectionAt(d, d.sections[d.sections.length - 1].id, t);
    expect(d.sections).toHaveLength(20);
    const pieces = copyPieces(d, [{ sectionId: d.sections[0].id, range: { startSec: 0, endSec: 1 } }]);
    expect(pastePieces(d, pieces, { sectionId: d.sections[3].id, atSec: Number.POSITIVE_INFINITY })).toBe(d);
  });
});

describe("a copy of footage already in the clip", () => {
  it("the original owns the footage; the copy doesn't", () => {
    const d = pastedIntoB();
    const primary = primarySourceSections(d.sections);
    expect([...primary].sort()).toEqual([d.sections[0].id, d.sections[1].id, d.sections[3].id].sort());
  });

  it("both can still be trimmed — the copy never fences the original in", () => {
    const d = pastedIntoB();
    const a = d.sections[0];
    const copy = d.sections[2];
    expect(spans(retimeSectionInDoc(d, a.id, { startSec: 100, endSec: 103.5 }))[0]).toEqual([100, 103.5]);
    expect(spans(retimeSectionInDoc(d, copy.id, { startSec: 100.5, endSec: 103.5 }))[2]).toEqual([100.5, 103.5]);
  });

  it("adding words next to copied footage extends the original, not the copy", () => {
    // Copy B's tail 108–110 and paste it first; then add 110–112.
    const d0 = twoScenes();
    const pieces = copyPieces(d0, [{ sectionId: d0.sections[1].id, range: { startSec: 108, endSec: 110 } }]);
    const d = includeRange(pastePieces(d0, pieces, { sectionId: d0.sections[0].id, atSec: Number.NEGATIVE_INFINITY }), { startSec: 110, endSec: 112 });
    expect(spans(d)).toEqual([[108, 110], [100, 104], [104, 112]]);
  });

  it("reads its words again where it plays, as their own scene", () => {
    const d = pastedIntoB();
    const s = shown(d);
    const i = s.indexOf("w107");
    expect(s.slice(i, i + 5)).toEqual(["w107", "[3]", "w101", "w102", "[4]"]);
    expect(s.filter((x) => x === "w101")).toHaveLength(2);
    const view = buildTranscriptView(d, words);
    const copyWords = view.words.filter((w) => w.sectionId === d.sections[2].id);
    expect(copyWords.map((w) => w.text)).toEqual(["w101", "w102"]);
    expect(copyWords.every((w) => w.block === d.sections[2].id)).toBe(true);
  });

  it("cutting a word from the copy leaves the original alone", () => {
    const d0 = pastedIntoB();
    const copy = d0.sections[2];
    const d = { ...d0, sections: d0.sections.map((s) => (s.id === copy.id ? addRemoval(s, { startSec: 101, endSec: 102 }, "manual") : s)) };
    const view = buildTranscriptView(d, words);
    const w101 = view.words.filter((w) => w.text === "w101");
    expect(w101.map((w) => [w.sectionId, w.state])).toEqual([
      [d.sections[0].id, "kept"],
      [copy.id, "removed"],
    ]);
  });
});
