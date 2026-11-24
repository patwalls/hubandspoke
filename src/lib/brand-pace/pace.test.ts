import { describe, it, expect } from "vitest";
import { paceOf, sortByPace, paceSummary, type BrandWeek } from "./pace";

const week = (o: Partial<BrandWeek>): BrandWeek => ({
  slug: "b",
  label: "B",
  posts: 0,
  priorPosts: 0,
  views: 0,
  weeklyGoal: null,
  weekFraction: 0.5,
  ...o,
});

describe("paceOf", () => {
  it("measures against the goal prorated to how far into the week we are", () => {
    // Goal 20, halfway through → 10 expected. 7 is under 80% of that.
    expect(paceOf(week({ weeklyGoal: 20, posts: 7 })).pace).toBe("behind");
    expect(paceOf(week({ weeklyGoal: 20, posts: 10 })).pace).toBe("on");
    expect(paceOf(week({ weeklyGoal: 20, posts: 13 })).pace).toBe("ahead");
  });

  it("falls back to the same point of last week when the brand has no goal", () => {
    const r = paceOf(week({ posts: 3, priorPosts: 10 }));
    expect(r.basis).toBe("last-week");
    expect(r.expected).toBe(10);
    expect(r.pace).toBe("behind");
  });

  it("does not call a brand behind when nothing was expected yet", () => {
    // Monday morning: goal 14 × 2% = 0.28 expected.
    expect(paceOf(week({ weeklyGoal: 14, weekFraction: 0.02, posts: 0 })).pace).toBe("quiet");
    expect(paceOf(week({ posts: 0, priorPosts: 0 })).pace).toBe("quiet");
    expect(paceOf(week({ posts: 2, priorPosts: 0 })).pace).toBe("ahead");
  });

  it("treats a zero goal as no goal", () => {
    expect(paceOf(week({ weeklyGoal: 0, posts: 5, priorPosts: 5 })).basis).toBe("last-week");
  });
});

describe("sortByPace", () => {
  it("puts the brand furthest behind first and quiet brands last", () => {
    const rows = [
      paceOf(week({ slug: "q", label: "Quiet" })),
      paceOf(week({ slug: "a", label: "Ahead", posts: 20, priorPosts: 5 })),
      paceOf(week({ slug: "b1", label: "Bit behind", posts: 7, priorPosts: 10 })),
      paceOf(week({ slug: "b2", label: "Way behind", posts: 1, priorPosts: 10 })),
      paceOf(week({ slug: "o", label: "On", posts: 10, priorPosts: 10 })),
    ];
    expect(sortByPace(rows).map((r) => r.slug)).toEqual(["b2", "b1", "o", "a", "q"]);
  });
});

describe("paceSummary", () => {
  it("leads with how many brands are behind", () => {
    const rows = [
      paceOf(week({ posts: 1, priorPosts: 10 })),
      paceOf(week({ posts: 10, priorPosts: 10 })),
      paceOf(week({ posts: 20, priorPosts: 10 })),
    ];
    expect(paceSummary(rows)).toBe("1 behind pace · 2 on pace");
  });

  it("says so when every brand is fine, and when nothing has happened yet", () => {
    expect(paceSummary([paceOf(week({ posts: 10, priorPosts: 10 }))])).toBe("1 on pace or ahead");
    expect(paceSummary([paceOf(week({}))])).toBe("nothing published yet");
  });
});
