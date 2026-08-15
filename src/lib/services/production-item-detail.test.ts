import { describe, expect, it } from "vitest";
import { computeTotalViews } from "./production-item-detail";

describe("computeTotalViews", () => {
  it("sums the post's own views with every descendant group", () => {
    const total = computeTotalViews(
      100,
      [[{ views: 10 }, { views: 5 }], [{ views: 3 }], [{ views: 2 }]],
    );
    expect(total).toBe(120);
  });

  // The regression this function exists for: the old `descendantViewsTotal`
  // excluded the parent, so a 120K post with 84K of derivatives rendered
  // "Views 120K / Total Views 84K".
  it("never returns less than the post's own views", () => {
    const ownViews = 120_000;
    const total = computeTotalViews(ownViews, [
      [{ views: 50_000 }, { views: 30_000 }],
      [{ views: 4_000 }],
    ]);

    expect(total).toBeGreaterThanOrEqual(ownViews);
    expect(total).toBe(204_000);
  });

  it("holds the floor when there are no descendants at all", () => {
    expect(computeTotalViews(120_000, [])).toBe(120_000);
    expect(computeTotalViews(120_000, [[], [], []])).toBe(120_000);
  });

  it("treats null/undefined view counts as zero, not as a negative", () => {
    expect(computeTotalViews(null, [[{ views: 7 }]])).toBe(7);
    expect(computeTotalViews(undefined, [[{ views: 7 }]])).toBe(7);
    expect(computeTotalViews(100, [[{ views: null }, { views: 9 }]])).toBe(109);
  });

  it("still reports the post's own views when nothing downstream has synced", () => {
    expect(
      computeTotalViews(235_103, [[{ views: null }, { views: null }]]),
    ).toBe(235_103);
  });
});
