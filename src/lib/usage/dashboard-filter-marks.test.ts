import { describe, it, expect } from "vitest";
import { dashboardFilterMarks, rangeBucket } from "./dashboard-filter-marks";

const base = {
  platform: "all",
  accountId: "all",
  format: "all",
  viewType: "weekly",
  startDate: "2026-08-24",
  endDate: "2026-11-22",
};

describe("dashboardFilterMarks", () => {
  it("records nothing when nothing changed", () => {
    expect(dashboardFilterMarks(base, { ...base })).toEqual([]);
  });

  it("keeps an enum value, lowercased", () => {
    expect(dashboardFilterMarks(base, { ...base, platform: "YouTube" })).toEqual([
      "dashboard:filter:platform:youtube",
    ]);
  });

  it("never records an account id or a format name, only set/all", () => {
    const set = { ...base, accountId: "3f2a9c1e-0000-4000-8000-000000000000", format: "Tech Stack With Hook" };
    expect(dashboardFilterMarks(base, set)).toEqual([
      "dashboard:filter:accountId:set",
      "dashboard:filter:format:set",
    ]);
    expect(dashboardFilterMarks(set, base)).toEqual([
      "dashboard:filter:accountId:all",
      "dashboard:filter:format:all",
    ]);
  });

  it("collapses a non-word value to other", () => {
    expect(dashboardFilterMarks(base, { ...base, platform: "a b/c" })).toEqual([
      "dashboard:filter:platform:other",
    ]);
  });

  it("records one range mark when either date moves", () => {
    expect(
      dashboardFilterMarks(base, { ...base, startDate: "2026-10-23", endDate: "2026-11-22" }),
    ).toEqual(["dashboard:filter:range:30d"]);
  });
});

describe("rangeBucket", () => {
  it.each([
    ["2026-11-15", "2026-11-22", "7d"],
    ["2026-10-23", "2026-11-22", "30d"],
    ["2026-08-24", "2026-11-22", "90d"],
    ["2025-11-22", "2026-11-22", "1y"],
    ["2024-01-01", "2026-11-22", "longer"],
    ["2026-11-22", "2026-11-01", "custom"],
    ["nope", "2026-11-22", "custom"],
  ])("%s..%s → %s", (s, e, want) => {
    expect(rangeBucket(s, e)).toBe(want);
  });
});
