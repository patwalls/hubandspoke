import { describe, it, expect } from "vitest";
import { capSeries, inProgressIndex, periodTrend, SERIES_SLOTS } from "./period-chart";

describe("inProgressIndex", () => {
  const periods = [
    { start: "2026-10-05", end: "2026-10-11" },
    { start: "2026-10-12", end: "2026-10-18" },
    { start: "2026-10-19", end: "2026-10-25" },
  ];
  it("flags the last period when today falls inside it", () => {
    expect(inProgressIndex(periods, "2026-10-20")).toBe(2);
  });
  it("is null once the range ends before today", () => {
    expect(inProgressIndex(periods, "2026-10-26")).toBeNull();
  });
});

describe("periodTrend", () => {
  it("ignores the in-progress period, so a partial week doesn't read as a drop", () => {
    // Four steady weeks, then a half-finished one.
    const t = periodTrend([10, 10, 10, 10, 3], 4);
    expect(t).toEqual({ kind: "change", pct: 0, window: 2 });
  });
  it("compares the last 4 complete periods to the 4 before", () => {
    const t = periodTrend([10, 10, 10, 10, 15, 15, 15, 15], null);
    expect(t).toEqual({ kind: "change", pct: 0.5, window: 4 });
  });
  it("calls a series that started from nothing new, not +Infinity%", () => {
    expect(periodTrend([0, 0, 2, 4], null)).toEqual({ kind: "new", window: 2 });
  });
  it("says nothing with under two complete periods or no activity", () => {
    expect(periodTrend([5, 2], 1)).toBeNull();
    expect(periodTrend([0, 0, 0, 0], null)).toBeNull();
  });
});

describe("capSeries", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `s${i}`, total: i }));
  const fold = (rest: { key: string; total: number }[]) => ({
    key: "other",
    total: rest.reduce((a, s) => a + s.total, 0),
  });

  it("leaves a chart within the colour slots alone", () => {
    const s = mk(SERIES_SLOTS);
    expect(capSeries(s, fold)).toBe(s);
  });
  it("folds the smallest into Other and keeps survivors in their order", () => {
    const out = capSeries(mk(10), fold);
    expect(out.map((s) => s.key)).toEqual([
      "s3", "s4", "s5", "s6", "s7", "s8", "s9", "other",
    ]);
    expect(out.at(-1)!.total).toBe(0 + 1 + 2);
  });
});
