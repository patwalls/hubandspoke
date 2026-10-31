import { describe, it, expect } from "vitest";
import { pickWinners, formatLift, scoreFormats, type WinnerCandidate } from "./pick";

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

describe("pickWinners on posts whose views are estimated from likes", () => {
  const est = (id: string, likes: number, baselineLikesMedian: number): WinnerCandidate => ({
    id,
    title: id,
    views: likes * 165, // what view-estimator stores for a Facebook post
    baselineMedian: baselineLikesMedian * 165,
    baselinePosts: 100,
    metric: "likes",
    likes,
    baselineLikesMedian,
  });

  it("skips a post with a handful of likes even though its estimated views clear the views floor", () => {
    // 11 likes → 1,815 "views", 5.5× an account that usually gets 2 likes.
    expect(pickWinners([est("eleven-likes", 11, 2)])).toEqual([]);
  });

  it("judges a real hit on likes vs. usual likes", () => {
    const [w] = pickWinners([est("viral", 2_939, 2)]);
    expect(w.item.id).toBe("viral");
    expect(w.lift).toBe(1469.5);
  });

  it("ranks likes-judged and views-judged posts on one lift scale", () => {
    const winners = pickWinners([est("fb", 120, 40), c("tiktok", 16_000, 4_000)]);
    expect(winners.map((x) => [x.item.id, x.lift])).toEqual([
      ["tiktok", 4],
      ["fb", 3],
    ]);
  });
});

describe("formatLift", () => {
  it("shows one decimal under 10 and whole numbers above", () => {
    expect(formatLift(2.4)).toBe("2.4×");
    expect(formatLift(12.36)).toBe("12×");
    expect(formatLift(1240)).toBe("1,240×");
  });
});

describe("scoreFormats", () => {
  const f = (id: string, format: string | null, views: number, baselineMedian = 1_000, baselinePosts = 10) => ({
    ...c(id, views, baselineMedian, baselinePosts),
    format,
  });

  it("ranks formats by how often they beat their usual, not by one big post", () => {
    const scores = scoreFormats([
      // "Lucky": one 50× post out of five.
      f("l1", "Lucky", 50_000), f("l2", "Lucky", 900), f("l3", "Lucky", 800), f("l4", "Lucky", 700), f("l5", "Lucky", 1_000),
      // "Steady": 3 of 4 posts at 2×.
      f("s1", "Steady", 2_000), f("s2", "Steady", 2_000), f("s3", "Steady", 2_000), f("s4", "Steady", 900),
    ]);
    expect(scores.map((s) => s.format)).toEqual(["Steady", "Lucky"]);
    expect(scores[0]).toMatchObject({ posts: 4, wins: 3, hitRate: 0.75, bestLift: 2 });
    expect(scores[1]).toMatchObject({ posts: 5, wins: 1, bestLift: 50 });
  });

  it("counts a win by the strip's rules — tiny posts and accounts without a usual don't count", () => {
    const scores = scoreFormats([
      f("tiny", "F", 300, 20), // 15× but under the views floor: judged, not a win
      f("hit", "F", 3_000),
      f("ok", "F", 1_000),
      f("new-account", "F", 90_000, 1_000, 2), // not judged at all
    ]);
    expect(scores).toEqual([{ format: "F", posts: 3, wins: 1, hitRate: 1 / 3, bestLift: 3 }]);
  });

  it("needs a few judged posts and at least one win to rank a format; skips posts with no format", () => {
    expect(
      scoreFormats([
        f("a", "Two posts", 5_000), f("b", "Two posts", 5_000),
        f("c", "No wins", 1_000), f("d", "No wins", 1_000), f("e", "No wins", 1_000),
        f("x", null, 9_000), f("y", "  ", 9_000), f("z", null, 9_000),
      ]),
    ).toEqual([]);
  });
});
