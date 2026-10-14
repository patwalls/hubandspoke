import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "./doc";
import { compileRenderPlan } from "./plan";
import { includeRange, moveSection, retimeSectionInDoc, splitSectionAt } from "./sections";
import { buildTranscriptView } from "./transcript-view";
import type { EditorWord } from "./words";

// 100–110 split at 104 and 107 → three scenes A(100–104) B(104–107) C(107–110)
const threeScenes = () => {
  let d = createDefaultDoc({ startSec: 100, endSec: 110, hook: "" });
  d = splitSectionAt(d, "body", 104);
  return splitSectionAt(d, d.sections[1].id, 107);
};
const spans = (d: ReturnType<typeof threeScenes>) => d.sections.map((s) => [s.startSec, s.endSec]);

describe("moveSection (drag a scene on the timeline)", () => {
  it("moves the last scene to the beginning — and that's what plays first", () => {
    const d0 = threeScenes();
    const c = d0.sections[2].id;
    const d = moveSection(d0, c, 0);
    expect(spans(d)).toEqual([[107, 110], [100, 104], [104, 107]]);
    expect(compileRenderPlan(d, []).segments[0]).toMatchObject({ sectionId: c, sourceStartSec: 107 });
  });

  it("no-ops for the same place or an unknown scene, and clamps the index", () => {
    const d = threeScenes();
    expect(moveSection(d, d.sections[1].id, 1)).toBe(d);
    expect(moveSection(d, "nope", 0)).toBe(d);
    expect(spans(moveSection(d, d.sections[0].id, 99))).toEqual([[104, 107], [107, 110], [100, 104]]);
  });
});

describe("a moved order survives other edits", () => {
  const moved = () => {
    const d = threeScenes();
    return moveSection(d, d.sections[2].id, 0); // C, A, B
  };

  it("dragging a scene's edge keeps the play order", () => {
    const d0 = moved();
    const a = d0.sections[1];
    const d = retimeSectionInDoc(d0, a.id, { startSec: 101, endSec: 104 });
    expect(spans(d)).toEqual([[107, 110], [101, 104], [104, 107]]);
  });

  it("adding words keeps the play order (touching = in place; new = after its source predecessor)", () => {
    const d1 = includeRange(moved(), { startSec: 110, endSec: 112 }); // touches C (first)
    expect(spans(d1)).toEqual([[107, 112], [100, 104], [104, 107]]);
    const d2 = includeRange(moved(), { startSec: 50, endSec: 55 }); // nothing before it in the recording
    expect(spans(d2)[0]).toEqual([50, 55]);
  });

  const words: EditorWord[] = Array.from({ length: 120 }, (_, i) => ({ index: i, text: `w${i}`, startSec: i, endSec: i + 0.8 }));
  const shown = (d: ReturnType<typeof threeScenes>) =>
    buildTranscriptView(d, words).tokens.flatMap((t) => (t.kind === "word" ? [t.text] : t.kind === "marker" ? [`[${t.index}]`] : []));

  it("a moved scene's text shows where it now plays; everything else stays in recorded order", () => {
    const view = buildTranscriptView(moved(), words);
    const markers = view.tokens.filter((t) => t.kind === "marker").map((m) => (m.kind === "marker" ? [m.startSec, m.index] : null));
    // C (107–110) now plays first → its text sits right before A, numbered 1
    expect(markers).toEqual([[107, 1], [100, 2], [104, 3]]);
    const s = shown(moved());
    const i = s.indexOf("w99");
    expect(s.slice(i, i + 6)).toEqual(["w99", "[1]", "w107", "w108", "w109", "[2]"]);
    expect(s[s.indexOf("w106") + 1]).toBe("w110"); // C's old spot: nothing left behind
    // every word exactly once; display order covers them all
    expect(s.filter((x) => /^w\d+$/.test(x))).toHaveLength(120);
    expect([...view.displayOrder].sort((a, b) => a - b)).toEqual(view.words.map((w) => w.pos));
  });

  it("a scene moved to the end shows after the last scene", () => {
    const d0 = threeScenes();
    const d = moveSection(d0, d0.sections[0].id, 2); // B, C, A
    const s = shown(d);
    const i = s.indexOf("w109");
    expect(s.slice(i, i + 3)).toEqual(["w109", "[3]", "w100"]);
  });

  it("nothing moved = the plain recorded-order view", () => {
    const view = buildTranscriptView(threeScenes(), words);
    expect(view.displayOrder).toEqual(view.words.map((w) => w.pos));
    expect(view.words.every((w) => w.block === "main")).toBe(true);
  });
});
