import { describe, it, expect } from "vitest";
import { buildPeriods, findPeriod } from "./dates";

describe("buildPeriods daily", () => {
  it("keeps labels unique across a year boundary (labels key the metric maps)", () => {
    const periods = buildPeriods(new Date(2025, 0, 1), new Date(2026, 0, 2), "daily");
    const labels = periods.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe("1/1/25");
    expect(labels.at(-1)).toBe("1/2/26");
  });

  it("uses the short label inside one year", () => {
    const periods = buildPeriods(new Date(2026, 9, 1), new Date(2026, 9, 3), "daily");
    expect(periods.map((p) => p.label)).toEqual(["10/1", "10/2", "10/3"]);
  });
});

describe("findPeriod", () => {
  const periods = buildPeriods(new Date(2026, 8, 1), new Date(2026, 9, 20), "monthly");

  it("matches inclusive bounds", () => {
    expect(findPeriod("2026-09-01", periods)?.label).toBe("Sep 2026");
    expect(findPeriod("2026-09-30", periods)?.label).toBe("Sep 2026");
    expect(findPeriod("2026-10-20", periods)?.label).toBe("Oct 2026");
  });

  it("returns undefined outside the range", () => {
    expect(findPeriod("2026-08-31", periods)).toBeUndefined();
    expect(findPeriod("2026-10-21", periods)).toBeUndefined();
  });
});
