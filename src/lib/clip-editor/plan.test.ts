import { describe, it, expect } from "vitest";
import { createDefaultDoc, wordEditKey } from "./doc";
import { compileRenderPlan, outputToSource, sourceToOutput } from "./plan";
import { addRemoval } from "./removals";
import type { EditorWord } from "./words";

/** One word per second starting at `from`: w0 @ [from, from+0.8) … */
function wordsFrom(from: number, texts: string[]): EditorWord[] {
  return texts.map((text, i) => ({
    index: i,
    text,
    startSec: from + i,
    endSec: from + i + 0.8,
  }));
}

const baseDoc = () => createDefaultDoc({ startSec: 100, endSec: 110, hook: "Hook" });

describe("compileRenderPlan — timeline", () => {
  it("an untouched doc is one segment covering the whole range", () => {
    const plan = compileRenderPlan(baseDoc(), []);
    expect(plan.segments).toHaveLength(1);
    expect(plan.totalFrames).toBe(300);
    expect(plan.durationSec).toBe(10);
    expect(plan.inputs).toEqual([
      { sectionId: "body", seekSec: 100, readDurationSec: 11 },
    ]);
  });

  it("removals close the gap on the output timeline", () => {
    const doc = baseDoc();
    doc.sections[0] = addRemoval(doc.sections[0], { startSec: 102, endSec: 104 }, "manual");
    const plan = compileRenderPlan(doc, []);
    expect(plan.segments.map((s) => [s.frameStart, s.frameEnd])).toEqual([
      [0, 60],
      [120, 300],
    ]);
    expect(plan.segments[1].outStartSec).toBe(2);
    expect(plan.durationSec).toBe(8);
  });

  it("snaps cuts to whole frames so audio and video cut at the same instant", () => {
    const doc = baseDoc();
    doc.sections[0] = addRemoval(doc.sections[0], { startSec: 101.013, endSec: 102.487 }, "filler");
    const plan = compileRenderPlan(doc, []);
    for (const seg of plan.segments) {
      expect(Number.isInteger(seg.frameStart)).toBe(true);
      expect(Number.isInteger(seg.frameEnd)).toBe(true);
      expect(seg.sourceStartSec).toBeCloseTo(100 + seg.frameStart / 30, 9);
    }
  });

  it("drops sliver segments left between two removals", () => {
    const doc = baseDoc();
    let s = addRemoval(doc.sections[0], { startSec: 102, endSec: 103 }, "filler");
    s = addRemoval(s, { startSec: 103.04, endSec: 104 }, "silence"); // 40ms keep between
    doc.sections[0] = s;
    const plan = compileRenderPlan(doc, []);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].frameEnd).toBe(60);
    expect(plan.segments[1].frameStart).toBe(120);
  });

  it("seeks to the first KEPT frame when the head of a section is removed", () => {
    const doc = baseDoc();
    doc.sections[0] = addRemoval(doc.sections[0], { startSec: 100, endSec: 103 }, "manual");
    const plan = compileRenderPlan(doc, []);
    expect(plan.inputs[0].seekSec).toBe(103);
    expect(plan.segments[0].frameStart).toBe(0);
  });

  it("plays sections in array order, each from its own input", () => {
    const doc = createDefaultDoc({
      startSec: 100,
      endSec: 110,
      hook: "Hook",
      introRanges: [{ startSec: 5, endSec: 8 }],
    });
    const plan = compileRenderPlan(doc, []);
    expect(plan.inputs.map((i) => i.seekSec)).toEqual([5, 100]);
    expect(plan.segments.map((s) => [s.inputIndex, s.outStartSec, s.outEndSec])).toEqual([
      [0, 0, 3],
      [1, 3, 13],
    ]);
  });

  it("a fully-removed section contributes no input", () => {
    const doc = createDefaultDoc({
      startSec: 100,
      endSec: 110,
      hook: "Hook",
      introRanges: [{ startSec: 5, endSec: 8 }],
    });
    doc.sections[0] = addRemoval(doc.sections[0], { startSec: 5, endSec: 8 }, "manual");
    const plan = compileRenderPlan(doc, []);
    expect(plan.inputs).toHaveLength(1);
    expect(plan.segments.every((s) => s.inputIndex === 0)).toBe(true);
  });
});

describe("compileRenderPlan — captions", () => {
  it("captions only kept words, re-timed onto the output timeline", () => {
    const doc = baseDoc();
    const words = wordsFrom(100, ["so", "um", "this", "works"]);
    doc.sections[0] = addRemoval(doc.sections[0], { startSec: 101, endSec: 102 }, "filler");
    const plan = compileRenderPlan(doc, words);
    const spoken = plan.captions!.cues.flatMap((c) => c.words.map((w) => w.text));
    expect(spoken).toEqual(["so", "this", "works"]);
    const thisWord = plan.captions!.cues.flatMap((c) => c.words).find((w) => w.text === "this")!;
    expect(thisWord.outStartSec).toBeCloseTo(1, 5); // was at 102s source, 1s removed before it
  });

  it("respects maxWordsPerCue and keeps the highlight continuous inside a cue", () => {
    const doc = baseDoc();
    const plan = compileRenderPlan(doc, wordsFrom(100, ["a", "b", "c", "d"]).map((w, i) => ({
      ...w, startSec: 100 + i * 0.3, endSec: 100 + i * 0.3 + 0.25,
    })));
    const [first, second] = plan.captions!.cues;
    expect(first.words.map((w) => w.text)).toEqual(["a", "b", "c"]);
    expect(second.words.map((w) => w.text)).toEqual(["d"]);
    expect(first.words[0].outEndSec).toBe(first.words[1].outStartSec);
    expect(first.outEndSec).toBeLessThanOrEqual(second.outStartSec);
  });

  it("breaks a cue on a long pause", () => {
    const plan = compileRenderPlan(baseDoc(), [
      { index: 0, text: "one", startSec: 100, endSec: 100.3 },
      { index: 1, text: "two", startSec: 102, endSec: 102.3 },
    ]);
    expect(plan.captions!.cues).toHaveLength(2);
  });

  it("applies word corrections to captions without touching the cut", () => {
    const doc = baseDoc();
    const words = wordsFrom(100, ["shopfy"]);
    const before = compileRenderPlan(doc, words);
    doc.wordEdits[wordEditKey(100)] = "Shopify";
    const after = compileRenderPlan(doc, words);
    expect(after.captions!.cues[0].words[0].text).toBe("Shopify");
    expect(after.segments).toEqual(before.segments);
  });

  it("is null when the captions layer is hidden", () => {
    const doc = baseDoc();
    doc.layers = doc.layers.map((l) => (l.type === "captions" ? { ...l, visible: false } : l));
    expect(compileRenderPlan(doc, wordsFrom(100, ["hi"])).captions).toBeNull();
  });
});

describe("time mapping", () => {
  const doc = baseDoc();
  doc.sections[0] = addRemoval(doc.sections[0], { startSec: 102, endSec: 104 }, "manual");
  const plan = compileRenderPlan(doc, []);

  it("round-trips kept moments", () => {
    expect(sourceToOutput(plan, 105)).toBeCloseTo(3, 9);
    expect(outputToSource(plan, 3)).toEqual({ segmentIndex: 1, sourceSec: 105 });
  });

  it("maps a removed moment to where playback resumes", () => {
    expect(sourceToOutput(plan, 103)).toBe(2);
  });
});
