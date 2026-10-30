import { describe, expect, it } from "vitest";
import { locateInSegments } from "./transcript-search";

const segs = [
  { startSec: 0, text: "So the first thing people get wrong" },
  { startSec: 4.2, text: "is they think a newsletter is about writing." },
  { startSec: 9.8, text: "We changed the pricing page three times." },
];

describe("locateInSegments", () => {
  it("returns the first segment that holds every query word, case-insensitively", () => {
    expect(locateInSegments(segs, "Pricing Page")).toEqual({ startSec: 9.8, text: "We changed the pricing page three times." });
  });
  it("falls back to the longest term when no segment has them all", () => {
    expect(locateInSegments(segs, "newsletter pricing")?.startSec).toBe(4.2);
  });
  it("ignores one-letter noise and returns null when nothing matches", () => {
    expect(locateInSegments(segs, "a")).toBeNull();
    expect(locateInSegments(segs, "quantum")).toBeNull();
  });
});
