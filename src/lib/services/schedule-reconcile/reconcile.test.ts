import { describe, it, expect } from "vitest";
import { staleWindowHours, AUTO_MATCH_SCORE, SUGGEST_SCORE } from "./reconcile";

describe("staleWindowHours", () => {
  it("gives fast short-form a 24h window", () => {
    for (const pt of [
      "x",
      "tiktok",
      "threads",
      "instagram_reel",
      "instagram_post",
      "instagram_story",
    ]) {
      expect(staleWindowHours(pt)).toBe(24);
    }
  });

  it("gives slower formats a 48h window", () => {
    for (const pt of [
      "youtube_long",
      "youtube_shorts",
      "youtube_community",
      "linkedin",
      "newsletter",
    ]) {
      expect(staleWindowHours(pt)).toBe(48);
    }
  });

  it("defaults unknown/null post types to 48h", () => {
    expect(staleWindowHours(null)).toBe(48);
    expect(staleWindowHours("something-weird")).toBe(48);
  });
});

describe("tier thresholds", () => {
  it("auto-match is the higher bar; suggest is the lower bar", () => {
    expect(AUTO_MATCH_SCORE).toBeGreaterThan(SUGGEST_SCORE);
    expect(SUGGEST_SCORE).toBeGreaterThan(0);
    expect(AUTO_MATCH_SCORE).toBeLessThanOrEqual(100);
  });
});
