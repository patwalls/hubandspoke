import { describe, expect, it } from "vitest";
import { frameTimes, speakingStretches } from "./frame-times";

const words = (spec: Array<[string, number, number]>) =>
  spec.map(([speakerId, startSec, endSec], index) => ({ index, text: "w", startSec, endSec, speakerId }));

describe("frameTimes", () => {
  it("spreads evenly across the middle of the video when nobody is diarized", () => {
    const t = frameTimes({ durationSec: 100, count: 3 });
    expect(t).toEqual([4, 50, 96]);
  });
  it("samples the guest's long stretches of speech, not the host's", () => {
    const w = words([
      ["S1", 0, 30], // host
      ["S2", 31, 120], // guest, 89s
      ["S1", 121, 200],
      ["S2", 201, 300], // guest, 99s
    ]);
    const t = frameTimes({ durationSec: 300, count: 4, words: w, speakers: [{ id: "S1", role: "host" }, { id: "S2", role: "guest" }] });
    expect(t).toHaveLength(4);
    for (const sec of t) expect((sec > 31 && sec < 120) || (sec > 201 && sec < 300)).toBe(true);
  });
  it("falls back to even spacing when the guest barely talks", () => {
    const w = words([["S2", 10, 20]]);
    expect(frameTimes({ durationSec: 100, count: 3, words: w, speakers: [{ id: "S2", role: "guest" }] })).toEqual([4, 50, 96]);
  });
  it("speakingStretches merges words with short gaps and drops short stretches", () => {
    const w = words([["S2", 0, 1], ["S2", 2, 10], ["S1", 11, 20], ["S2", 21, 23]]);
    expect(speakingStretches(w, new Set(["S2"]), 8)).toEqual([{ startSec: 0, endSec: 10 }]);
  });
});
