import { describe, expect, it } from "vitest";
import { endAtWord, snapEndToSentence, snapStartToSentence, startAtWord, wordsAround } from "./clip-trim";

// "We built it fast. Then we sold it. And people paid us every month."
const text = "We built it fast. Then we sold it. And people paid us every month.";
const words = text.split(" ").map((t, i) => ({ index: i, text: t, startSec: 100 + i * 0.5, endSec: 100 + i * 0.5 + 0.4 }));

describe("clip trim", () => {
  it("startAtWord / endAtWord add a little air and keep a sane range", () => {
    expect(startAtWord(words, 4, { startSec: 100, endSec: 106 })).toEqual({ startSec: 101.85, endSec: 106 });
    expect(endAtWord(words, 7, { startSec: 100, endSec: 106 })).toEqual({ startSec: 100, endSec: 104.15 });
    // End moved before the start → the start follows.
    expect(endAtWord(words, 1, { startSec: 105, endSec: 106 }).startSec).toBeLessThan(101);
  });
  it("snaps edges to the sentence the clip starts and ends in", () => {
    // Clip begins at "sold" (index 6) and ends at "paid" (index 10).
    const r = { startSec: words[6].startSec, endSec: words[10].endSec };
    expect(snapStartToSentence(words, r).startSec).toBeCloseTo(words[4].startSec - 0.15, 5); // "Then"
    expect(snapEndToSentence(words, r).endSec).toBeCloseTo(words[13].endSec + 0.25, 5); // "month."
  });
  it("without punctuation a capital after a lowercase word is a sentence break, and a snap never runs more than 12s", () => {
    const flat = "so that was really simple The first prototype was the panic button and it worked Then we shipped".split(" ").map((t, i) => ({ index: i, text: t, startSec: 200 + i * 0.5, endSec: 200 + i * 0.5 + 0.4 }));
    const r = { startSec: flat[7].startSec, endSec: flat[9].endSec }; // "prototype … panic"
    expect(snapStartToSentence(flat, r).startSec).toBeCloseTo(flat[5].startSec - 0.15, 5); // "The"
    expect(snapEndToSentence(flat, r).endSec).toBeCloseTo(flat[14].endSec + 0.25, 5); // "worked", before "Then"
    const endless = Array.from({ length: 200 }, (_, i) => ({ index: i, text: "word", startSec: i * 0.5, endSec: i * 0.5 + 0.4 }));
    const out = snapEndToSentence(endless, { startSec: 10, endSec: 20 });
    expect(out.endSec).toBeLessThanOrEqual(20 + 12 + 0.25);
  });
  it("wordsAround pads both sides", () => {
    expect(wordsAround(words, { startSec: 103, endSec: 104 }, 1).map((w) => w.text).join(" ")).toBe("Then we sold it. And people paid");
  });
});
