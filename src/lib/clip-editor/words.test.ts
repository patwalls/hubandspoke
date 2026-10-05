import { describe, it, expect } from "vitest";
import { findSilences, rangeForWordRun, resolveTranscriptWords, type EditorWord } from "./words";

const w = (index: number, startSec: number, endSec: number, text = `w${index}`): EditorWord => ({ index, text, startSec, endSec });

describe("rangeForWordRun", () => {
  const words = [w(0, 0, 0.4), w(1, 0.45, 0.9), w(2, 0.95, 1.4), w(3, 3, 3.4)];

  it("swallows the short gap after the run so no sliver of air is left", () => {
    expect(rangeForWordRun(words, 1, 1)).toEqual({ startSec: 0.45, endSec: 0.95 });
  });

  it("does NOT swallow a long pause — that is a separate decision", () => {
    expect(rangeForWordRun(words, 2, 2)).toEqual({ startSec: 0.95, endSec: 1.4 });
  });

  it("covers a multi-word run and handles the final word", () => {
    expect(rangeForWordRun(words, 0, 2)).toEqual({ startSec: 0, endSec: 1.4 });
    expect(rangeForWordRun(words, 3, 3)).toEqual({ startSec: 3, endSec: 3.4 });
    expect(rangeForWordRun(words, 2, 1)).toBeNull();
  });
});

describe("findSilences", () => {
  it("finds pauses over the threshold and leaves a breath on each side", () => {
    const words = [w(0, 10, 10.5), w(1, 10.6, 11), w(2, 12.5, 13)];
    expect(findSilences(words, { startSec: 10, endSec: 20 })).toEqual([
      { startSec: 11.15, endSec: 12.35 },
    ]);
  });

  it("ignores words outside the window", () => {
    const words = [w(0, 1, 1.5), w(1, 10, 10.5), w(2, 10.6, 11)];
    expect(findSilences(words, { startSec: 9, endSec: 20 })).toEqual([]);
  });
});

describe("resolveTranscriptWords", () => {
  it("uses real word timings when present", () => {
    const r = resolveTranscriptWords({
      words: [{ word: " hi ", startSec: 1, endSec: 1.2 }, { word: "", startSec: 2, endSec: 2.1 }],
      segments: [],
    });
    expect(r.synthetic).toBe(false);
    expect(r.words).toEqual([{ index: 0, text: "hi", startSec: 1, endSec: 1.2 }]);
  });

  it("gives a zero-length word back the time the word before swallowed", () => {
    // Real Whisper output: "Rourke" got no time and shared its start with
    // the next "in" — it couldn't be played, and a text fix hit both words.
    const r = resolveTranscriptWords({
      words: [
        { word: "in", startSec: 314.93, endSec: 315.61 },
        { word: "Rourke", startSec: 315.61, endSec: 315.61 },
        { word: "in", startSec: 315.61, endSec: 315.89 },
      ],
      segments: [],
    });
    const [a, rourke, b] = r.words;
    expect(a.startSec).toBe(314.93);
    expect(rourke.startSec).toBeCloseTo(314.93 + 0.68 * (2 / 8), 6);
    expect(rourke.endSec).toBe(315.61);
    expect(rourke.startSec).toBeLessThan(b.startSec); // distinct correction keys
    expect(b).toMatchObject({ startSec: 315.61, endSec: 315.89 }); // untouched
  });

  it("borrows from the next word when a collapsed word opens the transcript", () => {
    const r = resolveTranscriptWords({
      words: [
        { word: "So", startSec: 1, endSec: 1 },
        { word: "yeah", startSec: 1, endSec: 1.6 },
      ],
      segments: [],
    });
    expect(r.words[0]).toMatchObject({ startSec: 1, endSec: 1.2 });
    expect(r.words[1]).toMatchObject({ startSec: 1.2, endSec: 1.6 });
  });

  it("synthesizes timings from segments when the transcript has no words", () => {
    const r = resolveTranscriptWords({
      words: null,
      segments: [{ startSec: 10, endSec: 12, text: "ab abcdef" }],
    });
    expect(r.synthetic).toBe(true);
    expect(r.words.map((x) => x.text)).toEqual(["ab", "abcdef"]);
    expect(r.words[0].startSec).toBe(10);
    expect(r.words[1].endSec).toBeCloseTo(12, 9);
    expect(r.words[0].endSec).toBeCloseTo(10.5, 9); // 2 of 8 chars
  });
});
