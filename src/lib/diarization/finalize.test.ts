import { describe, it, expect } from "vitest";
import { applyNames, labelTranscript } from "./finalize";
import type { TimedWord } from "./assign";
import type { TranscriptSpeaker } from "./types";

const words: TimedWord[] = ["so", "how", "much", "about", "ten", "thousand"].map((word, i) => ({
  word, startSec: i * 0.5, endSec: i * 0.5 + 0.4,
}));
const segments = [{ startSec: 0, endSec: 3, text: "So, how much? About ten thousand." }];
const twoVoices = [
  { speakerId: "S1", startSec: 0, endSec: 1.45 },
  { speakerId: "S2", startSec: 1.45, endSec: 3 },
];

describe("labelTranscript", () => {
  it("labels words and segments, numbering unnamed speakers by first appearance", () => {
    const t = labelTranscript({ words, segments, turns: twoVoices });
    expect(t.words.map((w) => w.speakerId)).toEqual(["S1", "S1", "S1", "S2", "S2", "S2"]);
    expect(t.segments.map((s) => [s.speaker, s.text])).toEqual([
      ["Speaker 1", "So, how much?"],
      ["Speaker 2", "About ten thousand."],
    ]);
    expect(t.speakers.map((s) => [s.id, s.name, s.wordCount])).toEqual([["S1", null, 3], ["S2", null, 3]]);
  });

  it("a single voice is recorded but NOT printed on every line", () => {
    const t = labelTranscript({ words, segments, turns: [{ speakerId: "S1", startSec: 0, endSec: 3 }] });
    expect(t.speakers).toHaveLength(1);
    expect(t.segments[0]).toEqual({ startSec: 0, endSec: 3, text: segments[0].text });
    expect(t.words.every((w) => !("speakerId" in w))).toBe(true);
  });

  it("re-running detection keeps a name the USER set, and drops a stale LLM guess", () => {
    const previous: TranscriptSpeaker[] = [
      { id: "S1", name: "Pat Walls", nameSource: "user", role: "host", talkTimeSec: 1, wordCount: 1, firstSec: 0 },
      { id: "S2", name: "Wrong Guess", nameSource: "llm", role: "guest", talkTimeSec: 1, wordCount: 1, firstSec: 1 },
    ];
    const t = labelTranscript({ words, segments, turns: twoVoices, previous });
    expect(t.speakers.map((s) => [s.name, s.nameSource])).toEqual([["Pat Walls", "user"], [null, null]]);
    expect(t.segments.map((s) => s.speaker)).toEqual(["Pat Walls", "Speaker 2"]);
  });

  it("clears labels left by an earlier run when detection now finds nothing", () => {
    const stale = [{ ...segments[0], speaker: "Old", speakerId: "S7" }];
    const t = labelTranscript({ words: words.map((w) => ({ ...w, speakerId: "S7" })), segments: stale, turns: [] });
    expect(t.speakers).toEqual([]);
    expect(t.segments[0]).toEqual(segments[0]);
    expect(t.words.every((w) => !("speakerId" in w))).toBe(true);
  });
});

describe("applyNames", () => {
  it("rewrites every segment's display name after a rename", () => {
    const t = labelTranscript({ words, segments, turns: twoVoices });
    const renamed = applyNames({
      ...t,
      speakers: t.speakers.map((s) => (s.id === "S2" ? { ...s, name: "Ken", nameSource: "user" as const } : s)),
    });
    expect(renamed.segments.map((s) => s.speaker)).toEqual(["Speaker 1", "Ken"]);
  });
});
