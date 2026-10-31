import { describe, it, expect } from "vitest";
import { pickWinners, formatLift, type WinnerCandidate } from "./pick";

const c = (id: string, views: number, baselineMedian: number, baselinePosts = 10): WinnerCandidate => ({
  id,
  title: id,
  views,
  baselineMedian,
  baselinePosts,
});

describe("pickWinners", () => {
  it("ranks by lift over the post's own account, not by raw views", () => {
    const winners = pickWinners([
      c("big-account-normal", 100_000, 80_000), // 1.25× — just its usual
      c("small-account-hit", 6_000, 1_000), // 6×
      c("mid", 9_000, 3_000), // 3×
    ]);
    expect(winners.map((w) => w.item.id)).toEqual(["small-account-hit", "mid"]);
    expect(winners[0].lift).toBe(6);
  });

  it("skips accounts without enough history to have a usual", () => {
    expect(pickWinners([c("new-account", 50_000, 1_000, 4)])).toEqual([]);
  });

  it("skips tiny posts even at a big multiple", () => {
    expect(pickWinners([c("tiny", 300, 20)])).toEqual([]);
  });

  it("skips a zero median instead of dividing by it", () => {
    expect(pickWinners([c("zero", 5_000, 0)])).toEqual([]);
  });

  it("breaks lift ties by views and caps the list", () => {
    const winners = pickWinners(
      [c("a", 2_000, 1_000), c("b", 4_000, 2_000), c("c", 9_000, 1_000)],
      { limit: 2 },
    );
    expect(winners.map((w) => w.item.id)).toEqual(["c", "b"]);
  });
});

describe("formatLift", () => {
  it("shows one decimal under 10 and whole numbers above", () => {
    expect(formatLift(2.4)).toBe("2.4×");
    expect(formatLift(12.36)).toBe("12×");
    expect(formatLift(1240)).toBe("1,240×");
  });
});
