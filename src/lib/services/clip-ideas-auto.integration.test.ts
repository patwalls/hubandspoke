import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestFormat, createTestProductionItem } from "@/test/factories";
import { selectAutoClipIdeaJobs } from "./clip-ideas-auto";

const DAYS = 24 * 3600_000;

const savedEnv = process.env.AUTO_CLIP_IDEAS_BRANDS;
beforeEach(() => {
  delete process.env.AUTO_CLIP_IDEAS_BRANDS;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.AUTO_CLIP_IDEAS_BRANDS;
  else process.env.AUTO_CLIP_IDEAS_BRANDS = savedEnv;
});

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

  it("auto-enables a brand the moment it gains a clippable format (no env allowlist)", async () => {
    // The onboarding contract: no AUTO_CLIP_IDEAS_BRANDS config edit — a
    // brand with zero clippable formats is off, and creating a clippable
    // format is the opt-in that flips it on.
    const brand = `vitest-brand-${randomUUID().slice(0, 8)}`;
    const pillar = await createTestProductionItem({
      brand,
      accountId: null,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: new Date(Date.now() - 1 * DAYS),
    });

    expect(await selectAutoClipIdeaJobs(pillar.id)).toMatchObject({
      eligible: false,
      reason: "no-clippable-formats",
    });

    const fmt = await createTestFormat({ brand, isClippableFormat: true });
    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.jobs.map((j) => j.targetFormatId)).toEqual([fmt.id]);
    }
  });

  it("still honors an explicit AUTO_CLIP_IDEAS_BRANDS allowlist over the formats-derived gate", async () => {
    const brand = `vitest-brand-${randomUUID().slice(0, 8)}`;
    await createTestFormat({ brand, isClippableFormat: true });
    const pillar = await createTestProductionItem({
      brand,
      accountId: null,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: new Date(Date.now() - 1 * DAYS),
    });

    process.env.AUTO_CLIP_IDEAS_BRANDS = "starter-story";
    expect(await selectAutoClipIdeaJobs(pillar.id)).toMatchObject({
      eligible: false,
      reason: `brand-not-auto-enabled-${brand}`,
    });
  });
});
