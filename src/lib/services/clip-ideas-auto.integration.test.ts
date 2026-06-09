import { describe, it, expect } from "vitest";
import { createTestFormat, createTestProductionItem } from "@/test/factories";
import { selectAutoClipIdeaJobs } from "./clip-ideas-auto";

const DAYS = 24 * 3600_000;

describe("selectAutoClipIdeaJobs", () => {
  it("fans out one job per clippable format for an eligible item", async () => {
    const clippable = await createTestFormat({
      brand: "starter-story",
      isClippableFormat: true,
    });
    const nonClippable = await createTestFormat({
      brand: "starter-story",
      isClippableFormat: false,
    });
    const pillar = await createTestProductionItem({
      brand: "starter-story",
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: new Date(Date.now() - 1 * DAYS),
    });

    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      const formatIds = result.jobs.map((j) => j.targetFormatId);
      expect(formatIds).toContain(clippable.id);
      expect(formatIds).not.toContain(nonClippable.id);
    }
  });

  it("returns the gate reason for an ineligible item", async () => {
    const pillar = await createTestProductionItem({
      brand: "starter-story",
      postType: "youtube_shorts",
      sourceType: "original",
      publishedAt: new Date(Date.now() - 1 * DAYS),
    });

    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result).toMatchObject({ eligible: false, reason: "post-type-youtube_shorts" });
  });
});
