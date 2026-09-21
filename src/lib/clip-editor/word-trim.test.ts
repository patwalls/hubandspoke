import { describe, expect, it } from "vitest";
import { addRemoval, keptRanges } from "./removals";
import { applyWordTrim, stepWordTrim, wordTrimWindow } from "./word-trim";
import type { EditorWord } from "./words";

// The real case (2026-09-21): "This fixes that." then "They're … everywhere."
// cut by hand from the next word's start — the half second after "that."
// (breath + the onset of "They're") still played.
const words: EditorWord[] = [
  { index: 0, text: "This", startSec: 428.52, endSec: 428.84 },
  { index: 1, text: "fixes", startSec: 428.84, endSec: 429.12 },
  { index: 2, text: "that.", startSec: 429.12, endSec: 429.58 },
  { index: 3, text: "They're", startSec: 430.1, endSec: 430.54 },
  { index: 4, text: "very", startSec: 430.54, endSec: 431.06 },
];
const base = { id: "body", role: "body" as const, startSec: 388.42, endSec: 452.5, removals: [] };
const cut = addRemoval(base, { startSec: 430.1, endSec: 439.8 }, "manual");

describe("a word's trim window", () => {
  it("spans from the previous word's end to the next word's start, and reads the cuts already there", () => {
    const win = wordTrimWindow(cut, words, 2)!;
    expect(win).toMatchObject({ minSec: 429.12, maxSec: 430.1, wordStartSec: 429.12, wordEndSec: 429.58, inSec: 429.12, outSec: 430.1 });
    expect(win.neighbours.map((n) => n.text)).toEqual(["This", "fixes", "that.", "They're", "very"]);
  });

  it("reaches at most a second into a long silence", () => {
    const far: EditorWord[] = [words[2], { index: 3, text: "Then", startSec: 435, endSec: 435.4 }];
    expect(wordTrimWindow(base, far, 0)!.maxSec).toBe(430.58);
    expect(wordTrimWindow(base, far, 0)!.minSec).toBe(428.12);
  });

  it("the first end ▷ press cuts the gap after the word, the next shaves the word; the join is one removal", () => {
    let win = wordTrimWindow(cut, words, 2)!;
    const first = stepWordTrim(win, "end")!;
    expect(first.outSec).toBe(429.58);
    let section = applyWordTrim(cut, win, first.inSec, first.outSec);
    // the gap cut abuts the manual cut: what plays after "that." is "A lot…"
    expect(keptRanges(section).some((r) => Math.abs(r.endSec - 429.58) < 1e-6)).toBe(true);
    win = wordTrimWindow(section, words, 2)!;
    expect(win.outSec).toBe(429.58);
    const second = stepWordTrim(win, "end")!;
    expect(second.outSec).toBeCloseTo(429.5, 5);
    section = applyWordTrim(section, win, second.inSec, second.outSec);
    expect(keptRanges(section).some((r) => Math.abs(r.endSec - 429.5) < 1e-6)).toBe(true);
    // the manual cut is untouched
    expect(section.removals.some((r) => r.reason === "manual" && r.endSec === 439.8)).toBe(true);
  });

  it("dragging never cuts the word's middle, and can give the gap back", () => {
    const win = wordTrimWindow(cut, words, 2)!;
    const trimmed = applyWordTrim(cut, win, 429.4, 429.45); // mid is 429.35
    expect(wordTrimWindow(trimmed, words, 2)).toMatchObject({ inSec: 429.32, outSec: 429.45 });
    const restored = applyWordTrim(trimmed, win, win.minSec, win.maxSec);
    expect(restored.removals.filter((r) => r.reason === "trim")).toHaveLength(0);
    expect(stepWordTrim({ ...win, inSec: 429.32, outSec: 429.38 }, "end")).toBeNull();
  });
});
