import { describe, it, expect } from "vitest";
import { dwellMarksDue } from "./post-read-marks";

describe("dwellMarksDue", () => {
  it("fires nothing before 10 s on screen (a bounce)", () => {
    expect(dwellMarksDue(9_999, new Set())).toEqual([]);
  });

  it("fires the 10 s mark once, then never again", () => {
    expect(dwellMarksDue(10_000, new Set())).toEqual(["content:read:dwell-10s"]);
    expect(dwellMarksDue(30_000, new Set(["content:read:dwell-10s"]))).toEqual([]);
  });

  it("catches up both marks when a long gap passes between checks", () => {
    expect(dwellMarksDue(61_000, new Set())).toEqual([
      "content:read:dwell-10s",
      "content:read:dwell-60s",
    ]);
  });
});

describe("post read marks", () => {
  it("are all marks /api/usage accepts (an invalid one would 400 silently)", async () => {
    const { isValidMark } = await import("./screen");
    const { DWELL_MARKS, ACTIVITY_MARK, PREVIEW_PLAY_MARK } = await import("./post-read-marks");
    for (const m of [...DWELL_MARKS.map((d) => d.mark), ACTIVITY_MARK, PREVIEW_PLAY_MARK]) {
      expect(isValidMark(m)).toBe(true);
    }
  });
});
