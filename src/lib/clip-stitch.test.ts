import { describe, it, expect } from "vitest";
import { locateSupportingMoments, needsStitchSuggest, snapToCues } from "./clip-stitch";
import type { TranscriptSegment, TranscriptWord } from "./clip-anchor-utils";

// A 3-cue transcript: cue A 0–10 s, cue B 100–110 s (the section), cue C 300–308 s.
const lines: Array<[number, number, string]> = [
  [0, 10, "first open the settings panel and turn on the beta toggle right here"],
  [100, 110, "and that is how we got the whole video done in five minutes flat"],
  [300, 308, "the free plan gives you ten exports a month which is plenty"],
];
const words: TranscriptWord[] = [];
const segments: TranscriptSegment[] = [];
for (const [s, e, text] of lines) {
  const ws = text.split(" ");
  const step = (e - s) / ws.length;
  ws.forEach((w, i) =>
    words.push({ word: w, startSec: s + i * step, endSec: s + (i + 1) * step }),
  );
  segments.push({ startSec: s, endSec: e, text });
}
const section = { sectionStartSec: 95, sectionEndSec: 140, words, segments };

describe("locateSupportingMoments", () => {
  it("turns verbatim quotes outside the section into cue-aligned ranges, in source order", () => {
    const out = locateSupportingMoments({
      ...section,
      quotes: [
        { quote: "ten exports a month which is plenty", role: "detail", why: "the price" },
        { quote: "open the settings panel and turn on the beta toggle", role: "setup", why: "the step it skips" },
      ],
    });
    expect(out.map((m) => [m.startSec, m.endSec, m.role])).toEqual([
      [0, 10, "setup"],
      [300, 308, "detail"],
    ]);
  });

  it("drops a quote that is already inside the clip's own window", () => {
    const out = locateSupportingMoments({
      ...section,
      quotes: [{ quote: "got the whole video done in five minutes", role: "payoff" }],
    });
    expect(out).toEqual([]);
  });

  it("drops paraphrases, short quotes and junk, and never throws", () => {
    expect(
      locateSupportingMoments({
        ...section,
        quotes: [
          { quote: "you get ten free exports every single month" }, // paraphrase
          { quote: "beta toggle" }, // too short
          null,
          "a string",
        ],
      }),
    ).toEqual([]);
    expect(locateSupportingMoments({ ...section, quotes: "nope" })).toEqual([]);
  });

  it("keeps at most three, drops duplicates of the same moment, defaults an unknown role", () => {
    const q = { quote: "ten exports a month which is plenty", role: "punchline" };
    const out = locateSupportingMoments({ ...section, quotes: [q, q, q, q] });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("detail");
  });
});

describe("snapToCues", () => {
  it("widens a word range to the cues it touches", () => {
    expect(snapToCues(102, 104, segments)).toEqual({ startSec: 100, endSec: 110 });
  });
});

describe("needsStitchSuggest (M3)", () => {
  const base = { promptVersion: 1, supportingMoments: null, killedAt: null };
  it("is true only for a live pre-v2 section never asked", () => {
    expect(needsStitchSuggest(base)).toBe(true);
    expect(needsStitchSuggest({ ...base, supportingMoments: [] })).toBe(false); // asked, none
    expect(needsStitchSuggest({ ...base, promptVersion: 2 })).toBe(false); // v2 NULL = picker found none
    expect(needsStitchSuggest({ ...base, killedAt: new Date() })).toBe(false);
    expect(needsStitchSuggest(null)).toBe(false);
  });
});
