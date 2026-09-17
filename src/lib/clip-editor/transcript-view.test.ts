import { describe, it, expect } from "vitest";
import { createDefaultDoc, wordEditKey } from "./doc";
import { addRemoval } from "./removals";
import { includeRange, retimeSectionInDoc } from "./sections";
import { buildTranscriptView, selectionActions } from "./transcript-view";
import type { EditorWord } from "./words";

// The WHOLE source: one word per second, 0.8s long, 0s..119s. Clip is 100–110.
const words: EditorWord[] = Array.from({ length: 120 }, (_, i) => ({
  index: i, text: `w${i}`, startSec: i, endSec: i + 0.8,
}));
const doc = () => createDefaultDoc({ startSec: 100, endSec: 110, hook: "h" });
const posOf = (view: ReturnType<typeof buildTranscriptView>, t: string) =>
  view.words.findIndex((w) => w.text === t);

describe("buildTranscriptView", () => {
  it("shows every word of the source, tagged outside / kept / removed", () => {
    const d = doc();
    d.sections[0] = addRemoval(d.sections[0], { startSec: 102, endSec: 103 }, "filler");
    const view = buildTranscriptView(d, words);
    expect(view.words).toHaveLength(120);
    const by = (t: string) => view.words[posOf(view, t)];
    expect(by("w0")).toMatchObject({ state: "outside", sectionId: null });
    expect(by("w99").state).toBe("outside");
    expect(by("w100")).toMatchObject({ state: "kept", sectionId: "body" });
    expect(by("w102")).toMatchObject({ state: "removed", reason: "filler" });
    expect(by("w110").state).toBe("outside");
  });

  it("puts one marker at the start of each section, numbered in play order", () => {
    const d = includeRange(doc(), { startSec: 5, endSec: 8 });
    const view = buildTranscriptView(d, words);
    const markers = view.tokens.filter((t) => t.kind === "marker");
    expect(markers.map((m) => (m.kind === "marker" ? [m.index, m.startSec] : null))).toEqual([[1, 5], [2, 100]]);
    // and the marker sits immediately before the section's first word
    const i = view.tokens.findIndex((t) => t.kind === "marker" && t.index === 2);
    expect(view.tokens[i + 1]).toMatchObject({ kind: "word", text: "w100" });
  });

  it("shows corrections as the word text", () => {
    const d = doc();
    d.wordEdits[wordEditKey(101)] = "Shopify";
    expect(buildTranscriptView(d, words).words[101]).toMatchObject({ text: "Shopify", corrected: true });
  });

  it("emits a pause chip only for long pauses inside the clip", () => {
    const spaced: EditorWord[] = [
      { index: 0, text: "x", startSec: 50, endSec: 50.5 },
      { index: 1, text: "y", startSec: 53, endSec: 53.5 }, // long pause, but outside the clip
      { index: 2, text: "a", startSec: 100, endSec: 100.5 },
      { index: 3, text: "b", startSec: 102, endSec: 102.5 }, // 1.5s pause inside
      { index: 4, text: "c", startSec: 102.6, endSec: 103 }, // 0.1s pause
    ];
    const gaps = buildTranscriptView(doc(), spaced).tokens.filter((t) => t.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ range: { startSec: 100.65, endSec: 101.85 }, removed: false });
  });
});

describe("selectionActions", () => {
  it("turns selected in-clip words into a removable source range", () => {
    const d = doc();
    const view = buildTranscriptView(d, words);
    const a = selectionActions(view, d, 102, 103);
    expect(a.ranges).toEqual([{ sectionId: "body", range: { startSec: 102, endSec: 103.8 } }]);
    expect(a).toMatchObject({ allRemoved: false, include: [] });
  });

  it("offers Restore only when everything selected is already removed", () => {
    const d = doc();
    d.sections[0] = addRemoval(d.sections[0], { startSec: 102, endSec: 104 }, "manual");
    const view = buildTranscriptView(d, words);
    expect(selectionActions(view, d, 102, 103).allRemoved).toBe(true);
    expect(selectionActions(view, d, 102, 104).allRemoved).toBe(false);
    // words outside the clip are never "removed" — nothing to restore
    expect(selectionActions(view, d, 10, 12).allRemoved).toBe(false);
  });

  it("offers to add far-away words as their own section", () => {
    const d = doc();
    const a = selectionActions(buildTranscriptView(d, words), d, 5, 7);
    expect(a.include).toEqual([{ startSec: 5, endSec: 7.8 }]);
    expect(a.ranges).toEqual([]);
  });

  it("stretches an adjacent run to touch the clip so the two fuse", () => {
    const d = doc();
    const view = buildTranscriptView(d, words);
    // w110–w111 come right after the clip (which ends at 110.0)
    expect(selectionActions(view, d, 110, 111).include).toEqual([{ startSec: 110, endSec: 111.8 }]);
    // w98–w99 come right before it (starts at 100.0): stretched forward to 100
    expect(selectionActions(view, d, 98, 99).include).toEqual([{ startSec: 98, endSec: 100 }]);
  });

  it("splits a selection that spans the clip boundary into remove + add", () => {
    const d = doc();
    const a = selectionActions(buildTranscriptView(d, words), d, 108, 111);
    // ends at the last in-clip word (the 0.2s gap after it is too long to swallow)
    expect(a.ranges).toEqual([{ sectionId: "body", range: { startSec: 108, endSec: 109.8 } }]);
    expect(a.include).toEqual([{ startSec: 110, endSec: 111.8 }]);
  });

  it("offers start-here / end-here trims, but not at the existing edges", () => {
    const d = doc();
    const view = buildTranscriptView(d, words);
    const a = selectionActions(view, d, 104, 104);
    expect(a.startHere?.window).toEqual({ startSec: 104, endSec: 110 });
    expect(a.endHere?.window).toEqual({ startSec: 100, endSec: 104.8 });
    expect(selectionActions(view, d, 100, 100).startHere).toBeNull();
  });
});

describe("includeRange", () => {
  it("adds a distant range as a new section, in source order", () => {
    const d = includeRange(doc(), { startSec: 5, endSec: 8 });
    expect(d.sections.map((s) => [s.startSec, s.endSec])).toEqual([[5, 8], [100, 110]]);
    expect(new Set(d.sections.map((s) => s.id)).size).toBe(2);
  });

  it("extends a touching section in place, keeping its id and its removals", () => {
    let d = doc();
    d.sections[0] = addRemoval(d.sections[0], { startSec: 102, endSec: 103 }, "filler");
    d = includeRange(d, { startSec: 110, endSec: 115 });
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0]).toMatchObject({ id: "body", startSec: 100, endSec: 115 });
    expect(d.sections[0].removals).toEqual([{ startSec: 102, endSec: 103, reason: "filler" }]);
  });

  it("fuses two sections when the added range bridges them", () => {
    let d = includeRange(doc(), { startSec: 90, endSec: 95 });
    d = includeRange(d, { startSec: 95, endSec: 100 });
    expect(d.sections.map((s) => [s.startSec, s.endSec])).toEqual([[90, 110]]);
  });
});

describe("retimeSectionInDoc", () => {
  it("stops a dragged edge at the neighbouring section — sections never overlap", () => {
    let d = includeRange(doc(), { startSec: 50, endSec: 60 });
    d = retimeSectionInDoc(d, "body", { startSec: 40, endSec: 110 }); // drag start way past the neighbour
    const body = d.sections.find((s) => s.id === "body")!;
    expect(body.startSec).toBe(60);
  });
});
