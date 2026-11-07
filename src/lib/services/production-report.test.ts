import { describe, it, expect, vi } from "vitest";

// The report's two inputs are DB reads; stub them so this runs as a unit test.
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/db/queries", () => ({
  getProductionPipeline: vi.fn(async () => [
    {
      id: "clip-row",
      status: "Idea",
      format: "Repackage Section w/ Hook",
      platform: ["instagram"],
      pillarContentItemId: "pillar-1",
      sourceClipIdeaId: "idea-1",
      // The clip writer's own guess — ran ~10× high on published clips.
      clipEstimatedViews: 128_000,
    },
    {
      id: "clip-row-no-history",
      status: "Idea",
      format: "Brand New Format",
      platform: ["tiktok"],
      pillarContentItemId: null,
      sourceClipIdeaId: "idea-2",
      clipEstimatedViews: 90_000,
    },
    { id: "published-row", status: "Published", format: "X", platform: ["x"] },
  ]),
}));
vi.mock("@/lib/services/view-predictor", () => ({
  buildViewPredictorContext: vi.fn(async () => ({})),
  predictViews: vi.fn((target: { id: string }) =>
    target.id === "clip-row"
      ? {
          prediction: 10_000,
          p25: 4_000,
          p75: 25_000,
          confidence: "med",
          cohortBreakdown: [
            { cohort: "B", label: "Same format + platform", n: 12, median: 10_000, weight: 1 },
          ],
        }
      : null,
  ),
}));

import { computeProductionReport } from "./production-report";

describe("computeProductionReport — Est. Views on clip-idea rows", () => {
  it("shows the history-based prediction and range, not the clip writer's estimate", async () => {
    const { items } = await computeProductionReport("starter-story", false);
    const row = items.find((i) => i.id === "clip-row") as unknown as {
      prediction: { prediction: number; p25: number; p75: number; confidence: string };
    };
    expect(row.prediction.prediction).toBe(10_000);
    expect(row.prediction.p25).toBe(4_000);
    expect(row.prediction.p75).toBe(25_000);
    expect(row.prediction.confidence).toBe("med");
  });

  it("shows nothing rather than falling back to the writer's estimate when there's no history", async () => {
    const { items } = await computeProductionReport("starter-story", false);
    const row = items.find((i) => i.id === "clip-row-no-history") as unknown as {
      prediction: unknown;
    };
    expect(row.prediction).toBeNull();
  });
});
