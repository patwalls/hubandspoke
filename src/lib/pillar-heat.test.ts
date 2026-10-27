import { describe, it, expect } from "vitest";
import { withPillarHeat } from "./pillar-heat";

describe("withPillarHeat", () => {
  it("rates each video against its own channel's median, not the whole list", () => {
    const out = withPillarHeat([
      { accountId: "big", views: 100_000 },
      { accountId: "big", views: 200_000 },
      { accountId: "big", views: 400_000 },
      { accountId: "small", views: 1_000 },
      { accountId: "small", views: 2_000 },
      { accountId: "small", views: 8_000 },
    ]);
    expect(out.map((v) => v.heat)).toEqual([0.5, 1, 2, 0.5, 1, 4]);
  });

  it("uses the mean of the middle two for an even count", () => {
    const out = withPillarHeat([10, 20, 30, 40].map((views) => ({ accountId: "a", views })));
    expect(out[3].heat).toBe(1.6); // 40 / 25
  });

  it("says nothing with fewer than 3 channel videos, or a video without views", () => {
    const out = withPillarHeat([
      { accountId: "a", views: 10 },
      { accountId: "a", views: 20 },
      { accountId: "b", views: 5 },
      { accountId: "b", views: 5 },
      { accountId: "b", views: 5 },
      { accountId: "b", views: null },
      { accountId: null, views: 99 },
    ]);
    expect(out.map((v) => v.heat)).toEqual([null, null, 1, 1, 1, null, null]);
  });

  it("skips a channel whose median is 0 instead of dividing by it", () => {
    const out = withPillarHeat([0, 0, 0, 7].map((views) => ({ accountId: "a", views })));
    expect(out.every((v) => v.heat === null)).toBe(true);
  });
});
