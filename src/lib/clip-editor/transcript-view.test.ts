import { describe, it, expect } from "vitest";
import { createDefaultDoc, wordEditKey } from "./doc";
import { addRemoval } from "./removals";
import { buildTranscriptView, selectionActions } from "./transcript-view";
import type { EditorWord } from "./words";

// One word per second, 0.8s long, from 95s..114s. Clip is 100–110.
const words: EditorWord[] = Array.from({ length: 20 }, (_, i) => ({
  index: i, text: `w${95 + i}`, startSec: 95 + i, endSec: 95 + i + 0.8,
}));
const context = { startSec: 95, endSec: 115 };
const doc = () => createDefaultDoc({ startSec: 100, endSec: 110, hook: "h" });

describe("buildTranscriptView", () => {
  it("tags words outside / kept / removed and carries the removal reason", () => {
    const d = doc();
    d.sections[0] = addRemoval(d.sections[0], { startSec: 102, endSec: 103 }, "filler");
    const view = buildTranscriptView(d, words, context);
    const by = (t: string) => view.words.find((w) => w.text === t)!;
    expect(by("w99").state).toBe("outside");
    expect(by("w100").state).toBe("kept");
    expect(by("w102")).toMatchObject({ state: "removed", reason: "filler" });
    expect(by("w110").state).toBe("outside");
  });

  it("shows corrections as the word text", () => {
    const d = doc();
    d.wordEdits[wordEditKey(101)] = "Shopify";
    const w = buildTranscriptView(d, words, context).words.find((x) => x.word.startSec === 101)!;
    expect(w).toMatchObject({ text: "Shopify", corrected: true });
  });

  it("emits a gap chip only for long pauses inside the clip", () => {
    const spaced: EditorWord[] = [
      { index: 0, text: "a", startSec: 100, endSec: 100.5 },
      { index: 1, text: "b", startSec: 102, endSec: 102.5 }, // 1.5s pause
      { index: 2, text: "c", startSec: 102.6, endSec: 103 }, // 0.1s pause
    ];
    const view = buildTranscriptView(doc(), spaced, context);
    const gaps = view.sections[0].tokens.filter((t) => t.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ range: { startSec: 100.65, endSec: 101.85 }, removed: false });
  });
});

describe("selectionActions", () => {
  it("turns selected words into a removable source range", () => {
    const view = buildTranscriptView(doc(), words, context);
    const lo = view.words.findIndex((w) => w.text === "w102");
    const a = selectionActions(view, lo, lo + 1);
    expect(a.ranges).toEqual([{ sectionId: "body", range: { startSec: 102, endSec: 103.8 } }]);
    expect(a.allRemoved).toBe(false);
    expect(a.extend).toBeNull();
  });

  it("offers Restore only when everything selected is already removed", () => {
    const d = doc();
    d.sections[0] = addRemoval(d.sections[0], { startSec: 102, endSec: 104 }, "manual");
    const view = buildTranscriptView(d, words, context);
    const lo = view.words.findIndex((w) => w.text === "w102");
    expect(selectionActions(view, lo, lo + 1).allRemoved).toBe(true);
    expect(selectionActions(view, lo, lo + 2).allRemoved).toBe(false);
  });

  it("offers to extend the clip when words outside it are selected", () => {
    const view = buildTranscriptView(doc(), words, context);
    const before = view.words.findIndex((w) => w.text === "w98");
    expect(selectionActions(view, before, before).extend).toEqual({
      sectionId: "body", window: { startSec: 98, endSec: 110 },
    });
    const after = view.words.findIndex((w) => w.text === "w111");
    expect(selectionActions(view, after, after).extend?.window).toEqual({ startSec: 100, endSec: 111.8 });
  });

  it("offers start-here / end-here trims, but not at the existing edges", () => {
    const view = buildTranscriptView(doc(), words, context);
    const mid = view.words.findIndex((w) => w.text === "w104");
    const a = selectionActions(view, mid, mid);
    expect(a.startHere?.window).toEqual({ startSec: 104, endSec: 110 });
    expect(a.endHere?.window).toEqual({ startSec: 100, endSec: 104.8 });
    const first = view.words.findIndex((w) => w.text === "w100");
    expect(selectionActions(view, first, first).startHere).toBeNull();
  });
});
