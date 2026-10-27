import { describe, it, expect } from "vitest";
import { decodeNextRows, encodeNextRows, NEXT_ROWS_MAX_AGE_MS } from "./next-rows";

describe("next rows remembered for the production list", () => {
  const now = 1_800_000_000_000;

  it("round-trips the card's posts while fresh", () => {
    const raw = encodeNextRows(["a", "b"], now);
    expect(decodeNextRows(raw, now + 60_000)).toEqual(["a", "b"]);
  });

  it("forgets them once stale, so an old highlight never points at work you moved past", () => {
    const raw = encodeNextRows(["a"], now);
    expect(decodeNextRows(raw, now + NEXT_ROWS_MAX_AGE_MS + 1)).toEqual([]);
  });

  it("an empty list (nothing left waiting) clears the highlight", () => {
    expect(decodeNextRows(encodeNextRows([], now), now)).toEqual([]);
  });

  it("ignores missing, malformed or future-dated values", () => {
    expect(decodeNextRows(null, now)).toEqual([]);
    expect(decodeNextRows("not json", now)).toEqual([]);
    expect(decodeNextRows(JSON.stringify({ ids: "a", at: now }), now)).toEqual([]);
    expect(decodeNextRows(JSON.stringify({ ids: ["a", 3], at: now }), now)).toEqual(["a"]);
    expect(decodeNextRows(encodeNextRows(["a"], now + 10_000), now)).toEqual([]);
  });
});
