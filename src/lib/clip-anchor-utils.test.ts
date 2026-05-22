import { describe, it, expect } from "vitest";
import {
  alignRangeToCues,
  findAnchorInWords,
  resolveAnchorForRange,
  tokenize,
  type TranscriptSegment,
  type TranscriptWord,
} from "./clip-anchor-utils";

// Quick fixture: a transcript with words spelled out + cue segments.
// Used by the resolver tests below.
function transcriptFixture(): {
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  durationSec: number;
} {
  // Sentence: "Today we do one point seven million dollars a year and we
  // saved customers ten million in taxes thanks to our boring niche."
  const words: TranscriptWord[] = [
    { word: "Today ", startSec: 60.0, endSec: 60.3 },
    { word: "we ", startSec: 60.3, endSec: 60.4 },
    { word: "do ", startSec: 60.4, endSec: 60.6 },
    { word: "one ", startSec: 60.6, endSec: 60.8 },
    { word: "point ", startSec: 60.8, endSec: 61.0 },
    { word: "seven ", startSec: 61.0, endSec: 61.3 },
    { word: "million ", startSec: 61.3, endSec: 61.7 },
    { word: "dollars ", startSec: 61.7, endSec: 62.0 },
    { word: "a ", startSec: 62.0, endSec: 62.1 },
    { word: "year ", startSec: 62.1, endSec: 62.4 },
    { word: "and ", startSec: 62.4, endSec: 62.5 },
    { word: "we ", startSec: 62.5, endSec: 62.6 },
    { word: "saved ", startSec: 62.6, endSec: 62.9 },
    { word: "customers ", startSec: 62.9, endSec: 63.3 },
    { word: "ten ", startSec: 63.3, endSec: 63.5 },
    { word: "million ", startSec: 63.5, endSec: 63.9 },
    { word: "in ", startSec: 63.9, endSec: 64.0 },
    { word: "taxes", startSec: 64.0, endSec: 64.4 },
  ];
  const segments: TranscriptSegment[] = [
    { startSec: 40.0, endSec: 50.0, text: "Setup A" },
    { startSec: 50.0, endSec: 58.0, text: "Setup B" },
    { startSec: 58.0, endSec: 65.0, text: "Reveal" },
    { startSec: 65.0, endSec: 75.0, text: "Follow-up" },
    { startSec: 75.0, endSec: 95.0, text: "Tangent" },
    { startSec: 95.0, endSec: 110.0, text: "Next topic" },
  ];
  return { words, segments, durationSec: 600 };
}

describe("tokenize", () => {
  it("lowercases, strips punctuation, keeps apostrophes, single-spaces", () => {
    expect(tokenize("It's Today, we do — $1.7M/year!").join(" ")).toBe(
      "it's today we do 1 7m year",
    );
  });

  it("returns empty array for whitespace-only input", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("findAnchorInWords", () => {
  const { words } = transcriptFixture();

  it("matches a verbatim ≥8 word run in the transcript", () => {
    const m = findAnchorInWords(
      "Today we do one point seven million dollars a year",
      words,
    );
    expect(m).not.toBeNull();
    expect(m!.startSec).toBeCloseTo(60.0);
    expect(m!.endSec).toBeCloseTo(62.4);
  });

  it("survives a trailing period / smart-quote in the LLM's quote", () => {
    const m = findAnchorInWords(
      "Today we do one point seven million dollars a year.",
      words,
    );
    expect(m).not.toBeNull();
  });

  it("returns null when the words don't appear contiguously", () => {
    expect(
      findAnchorInWords(
        "Today we never built a one point seven million dollars business",
        words,
      ),
    ).toBeNull();
  });

  it("falls back to the longest fragment when the LLM glues with '...'", () => {
    const m = findAnchorInWords(
      "Today we do one... million in taxes thanks to our boring niche",
      words,
    );
    // The first fragment is 5 words (too short); second is also short →
    // both reject. Verify no match returned in that pathological case.
    expect(m).toBeNull();

    // Now a case where one fragment IS ≥8 words and contiguously matches.
    const m2 = findAnchorInWords(
      "and we saved customers ten million in taxes... irrelevant garbage",
      words,
    );
    expect(m2).not.toBeNull();
    expect(m2!.startSec).toBeCloseTo(62.4);
  });
});

describe("alignRangeToCues", () => {
  const { segments, durationSec } = transcriptFixture();

  it("snaps a range to the cue boundaries that contain the anchor", () => {
    const out = alignRangeToCues({
      intendedStartSec: 55.0, // not on a boundary
      intendedEndSec: 90.0,
      anchorStartSec: 61.0,
      anchorEndSec: 61.5,
      durationSec,
      segments,
    });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    // start must be ≥ 46.0 (anchor - 15s) and on a cue boundary at or before
    // anchorStart. End must be ≥ anchorEnd and on a cue boundary.
    expect([50.0, 58.0]).toContain(out.startSec);
    expect([65.0, 75.0, 95.0]).toContain(out.endSec);
    expect(out.endSec - out.startSec).toBeGreaterThanOrEqual(25);
    expect(out.endSec - out.startSec).toBeLessThanOrEqual(95);
  });

  it("returns error when no window fits", () => {
    const out = alignRangeToCues({
      intendedStartSec: 0,
      intendedEndSec: 30,
      anchorStartSec: 500, // way outside any segment
      anchorEndSec: 501,
      durationSec,
      segments,
    });
    expect("error" in out).toBe(true);
  });
});

describe("resolveAnchorForRange", () => {
  const { words, segments, durationSec } = transcriptFixture();

  it("ok path: anchor found + range snapped to cues", () => {
    const r = resolveAnchorForRange({
      intendedStartSec: 50.0,
      intendedEndSec: 90.0,
      anchorQuote: "Today we do one point seven million dollars a year",
      words,
      segments,
      durationSec,
      candidateLabel: "Section #1 (\"reveal\")",
    });
    expect(r.ok).toBe(true);
    expect(r.found).toBe(true);
    expect(r.anchorStartSec).toBeCloseTo(60.0);
    // Either snapped within the LLM's range, or accepted-as-is when the
    // anchor was already inside.
    expect(r.startSec).toBeLessThanOrEqual(60.0);
    expect(r.endSec).toBeGreaterThanOrEqual(62.4);
  });

  it("fail path: anchor not found", () => {
    const r = resolveAnchorForRange({
      intendedStartSec: 50,
      intendedEndSec: 90,
      anchorQuote: "This sentence is not in the transcript at all here yet",
      words,
      segments,
      durationSec,
      candidateLabel: "Section #2 (\"phantom\")",
    });
    expect(r.ok).toBe(false);
    expect(r.found).toBe(false);
    expect(r.failureReason).toContain("not found verbatim");
  });

  it("ok path: anchor found and snap applied (range adjusted to cue boundaries)", () => {
    // Anchor at second 60-62.4. LLM picks [55, 70] which doesn't sit
    // exactly on cue boundaries → resolver snaps to the nearest cue
    // boundaries that contain the anchor + fit 25-95s.
    const r = resolveAnchorForRange({
      intendedStartSec: 55.0,
      intendedEndSec: 70.0,
      anchorQuote: "Today we do one point seven million dollars a year",
      words,
      segments,
      durationSec,
      candidateLabel: "Section #3 (\"mid-cue\")",
    });
    expect(r.ok).toBe(true);
    expect(r.found).toBe(true);
    expect(r.snapApplied).toBe(true);
    // Boundaries should be drawn from the segments table.
    expect([50.0, 58.0]).toContain(r.startSec);
    expect([75.0, 95.0]).toContain(r.endSec);
  });
});
