import { describe, it, expect } from "vitest";
import { assignSpeakersToWords, labelSegments, summarizeSpeakers, type TimedWord } from "./assign";
import { mapChunkLabels, mergeReferences, pickReferences } from "./identity";
import type { SpeakerTurn } from "./types";

/** One word every 0.5s, 0.4s long, starting at `from`. */
const words = (from: number, texts: string[]): TimedWord[] =>
  texts.map((word, i) => ({ word, startSec: from + i * 0.5, endSec: from + i * 0.5 + 0.4 }));
const turn = (speakerId: string, startSec: number, endSec: number): SpeakerTurn => ({ speakerId, startSec, endSec });

describe("assignSpeakersToWords", () => {
  it("labels each word by the turn it overlaps most", () => {
    const w = words(0, ["so", "how", "much", "about", "ten", "thousand"]);
    const ids = assignSpeakersToWords(w, [turn("S1", 0, 1.45), turn("S2", 1.45, 3)]);
    expect(ids).toEqual(["S1", "S1", "S1", "S2", "S2", "S2"]);
  });

  it("a boundary landing mid-word goes to whoever has more of the word", () => {
    const w: TimedWord[] = [{ word: "right", startSec: 1.0, endSec: 1.4 }];
    expect(assignSpeakersToWords(w, [turn("S1", 0, 1.1), turn("S2", 1.1, 2)])).toEqual(["S2"]);
  });

  it("ignores the diarizer's zero-length junk turns", () => {
    const w = words(0, ["a", "b", "c", "d"]);
    // observed in the wild: `[A] 24.9–24.9 "Where"`
    const ids = assignSpeakersToWords(w, [turn("S1", 0, 2), turn("S2", 0.5, 0.5)]);
    expect(ids).toEqual(["S1", "S1", "S1", "S1"]);
  });

  it("absorbs a one-word island inside another speaker's sentence", () => {
    const w = words(0, ["we", "grew", "yeah", "really", "fast", "then"]);
    const ids = assignSpeakersToWords(w, [turn("S1", 0, 1), turn("S2", 1, 1.45), turn("S1", 1.45, 3)]);
    expect(new Set(ids)).toEqual(new Set(["S1"]));
  });

  it("keeps a real interjection (3+ words)", () => {
    const w = words(0, ["we", "grew", "wait", "how", "much", "ten", "k"]);
    const ids = assignSpeakersToWords(w, [turn("S1", 0, 1), turn("S2", 1, 2.45), turn("S1", 2.45, 4)]);
    expect(ids).toEqual(["S1", "S1", "S2", "S2", "S2", "S1", "S1"]);
  });

  it("fills words the diarizer missed from their neighbours", () => {
    const w = words(0, ["a", "b", "c", "d"]);
    w[3] = { word: "d", startSec: 10, endSec: 10.4 }; // far from any turn
    expect(assignSpeakersToWords(w, [turn("S1", 0, 1.5)])).toEqual(["S1", "S1", "S1", "S1"]);
  });

  it("returns all-null when there is nothing usable, rather than guessing", () => {
    expect(assignSpeakersToWords(words(0, ["a", "b"]), [])).toEqual([null, null]);
  });
});

describe("labelSegments", () => {
  const w = words(0, ["so", "how", "much", "about", "ten", "thousand"]);
  const ids = ["S1", "S1", "S1", "S2", "S2", "S2"];

  it("splits a segment at a real speaker change, cutting the punctuated text at the same word", () => {
    const out = labelSegments([{ startSec: 0, endSec: 3, text: "So, how much? About ten thousand." }], w, ids);
    expect(out).toEqual([
      { startSec: 0, endSec: 1.4, text: "So, how much?", speakerId: "S1" },
      { startSec: 1.5, endSec: 3, text: "About ten thousand.", speakerId: "S2" },
    ]);
  });

  it("falls back to the majority speaker when text tokens don't line up with words", () => {
    const out = labelSegments([{ startSec: 0, endSec: 3, text: "So how much — about 10,000 dollars a month." }], w, [
      "S1", "S1", "S2", "S2", "S2", "S2",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].speakerId).toBe("S2");
  });

  it("does not split for a tiny minority run", () => {
    const out = labelSegments([{ startSec: 0, endSec: 3, text: "a b c d e f" }], w, ["S1", "S1", "S1", "S1", "S2", "S2"]);
    expect(out).toHaveLength(1);
    expect(out[0].speakerId).toBe("S1");
  });

  it("clears a stale speaker from a previous run when nothing is known now", () => {
    const out = labelSegments([{ startSec: 0, endSec: 3, text: "x", speaker: "Old Name", speakerId: "S9" }], w, [null, null, null, null, null, null]);
    expect(out[0]).toEqual({ startSec: 0, endSec: 3, text: "x" });
  });
});

describe("summarizeSpeakers", () => {
  it("orders by first appearance and totals talk time", () => {
    const w = words(0, ["a", "b", "c", "d"]);
    expect(summarizeSpeakers(w, ["S2", "S1", "S1", "S2"])).toEqual([
      { id: "S2", talkTimeSec: 0.8, wordCount: 2, firstSec: 0 },
      { id: "S1", talkTimeSec: 0.8, wordCount: 2, firstSec: 0.5 },
    ]);
  });
});

describe("cross-chunk identity", () => {
  it("first chunk: every label is a new speaker", () => {
    const { byLabel, nextIndex } = mapChunkLabels(["A", "B", "A"], [], 0);
    expect(Object.fromEntries(byLabel)).toEqual({ A: "S1", B: "S2" });
    expect(nextIndex).toBe(2);
  });

  it("later chunk: known names keep their id; an unfamiliar label is a NEW speaker even if it's spelled 'A'", () => {
    const { byLabel, nextIndex } = mapChunkLabels(["S2", "A", "S1"], ["S1", "S2"], 2);
    expect(Object.fromEntries(byLabel)).toEqual({ S2: "S2", A: "S3", S1: "S1" });
    expect(nextIndex).toBe(3);
  });

  it("references come from the middle of each speaker's longest turn, within API limits", () => {
    const refs = pickReferences([turn("S1", 10, 40), turn("S1", 50, 53), turn("S2", 41, 45)], 0);
    const s1 = refs.find((r) => r.speakerId === "S1")!;
    expect(s1).toMatchObject({ chunkIndex: 0, durationSec: 8, startSec: 21 }); // centered on 25
    const s2 = refs.find((r) => r.speakerId === "S2")!;
    expect(s2.durationSec).toBeCloseTo(3.2, 5);
    for (const r of refs) {
      expect(r.durationSec).toBeGreaterThanOrEqual(2);
      expect(r.durationSec).toBeLessThanOrEqual(10);
    }
  });

  it("gives no reference to a speaker who only interjected — a bad reference is worse than none", () => {
    expect(pickReferences([turn("S1", 0, 30), turn("S2", 30, 31.5)], 0).map((r) => r.speakerId)).toEqual(["S1"]);
  });

  it("upgrades a short early reference, and keeps the 4 biggest talkers", () => {
    const existing = [{ speakerId: "S1", chunkIndex: 0, startSec: 1, durationSec: 2.5 }];
    const merged = mergeReferences(existing, [{ speakerId: "S1", chunkIndex: 1, startSec: 9, durationSec: 8 }], new Map([["S1", 100]]));
    expect(merged).toEqual([{ speakerId: "S1", chunkIndex: 1, startSec: 9, durationSec: 8 }]);

    const five = ["S1", "S2", "S3", "S4", "S5"].map((speakerId) => ({ speakerId, chunkIndex: 0, startSec: 0, durationSec: 5 }));
    const talk = new Map([["S1", 50], ["S2", 5], ["S3", 40], ["S4", 30], ["S5", 20]]);
    expect(mergeReferences([], five, talk).map((r) => r.speakerId)).toEqual(["S1", "S3", "S4", "S5"]);
  });
});
