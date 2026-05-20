import { describe, expect, it } from "vitest";
import { selectSpokeCandidates } from "./spoke-candidates";

// Smoke integration: exercises the full SQL path against the dev DB so a
// schema rename or a broken percentile_cont aggregate fails CI before it
// hits prod. Deeper assertion tests (in-flight skip, history boost, etc.)
// live in the unit suite — they target the pure pieces extracted from
// this function, where DB cohort noise doesn't interfere.

describe("selectSpokeCandidates (integration smoke)", () => {
  it("runs against the dev DB and returns the expected shape", async () => {
    const result = await selectSpokeCandidates({ brand: "starter-story" });
    expect(result).toMatchObject({
      items: expect.any(Array),
      stats: {
        rawPillars: expect.any(Number),
        rawFormats: expect.any(Number),
        rawPairs: expect.any(Number),
        droppedNoChannelCohort: expect.any(Number),
        droppedNoFormatCohort: expect.any(Number),
        droppedInFlight: expect.any(Number),
        droppedCooldown: expect.any(Number),
        droppedBelowThreshold: expect.any(Number),
      },
      config: {
        pillarWindowDays: 730,
        channelCohortWindowDays: 365,
        formatCohortWindowDays: 90,
        spokeThreshold: 1.0,
      },
    });
    for (const item of result.items) {
      expect(item.spokeScore).toBeGreaterThanOrEqual(1.0);
      expect(item.id).toBe(`${item.pillar.id}:${item.format.id}`);
      expect(item.whySpoke).toBeTruthy();
      expect(item.breakdown.pillarStrength).toBeGreaterThan(0);
      expect(item.breakdown.formatFit).toBeGreaterThan(0);
      expect(item.breakdown.freshnessFactor).toBeGreaterThanOrEqual(0.3);
    }
    // Items are sorted by SPOKE desc.
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].spokeScore).toBeGreaterThanOrEqual(
        result.items[i].spokeScore,
      );
    }
  });

  it("returns empty items for a brand with no production_items", async () => {
    const result = await selectSpokeCandidates({
      brand: "definitely-not-a-real-brand-slug-xyz",
    });
    expect(result.items).toEqual([]);
    expect(result.stats.rawPillars).toBe(0);
  });
});
