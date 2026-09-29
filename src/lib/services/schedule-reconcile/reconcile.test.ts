import { describe, it, expect } from "vitest";
import { AUTO_MATCH_SCORE, SUGGEST_SCORE } from "./reconcile";

// Surface / abandon windows are internal constants exercised end-to-end in
// reconcile.integration.test.ts (uniform 24h dated surface, 5-day no-date
// surface, 7-/14-day abandon). Nothing pure left to unit-test here beyond the
// tier thresholds.
describe("tier thresholds", () => {
  it("auto-match is the higher bar; suggest is the lower bar", () => {
    expect(AUTO_MATCH_SCORE).toBeGreaterThan(SUGGEST_SCORE);
    expect(SUGGEST_SCORE).toBeGreaterThan(0);
    expect(AUTO_MATCH_SCORE).toBeLessThanOrEqual(100);
  });
});
