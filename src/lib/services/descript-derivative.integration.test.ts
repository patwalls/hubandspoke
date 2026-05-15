import { describe, expect, it } from "vitest";

import {
  hasDescriptableMedia,
  loadPillarForSource,
} from "./descript-derivative";
import { createTestProductionItem } from "@/test/factories";

describe("hasDescriptableMedia", () => {
  it("true when the source has its own composition", () => {
    const source = {
      id: "s",
      descriptProjectId: "p1",
      descriptCompositionId: "c1",
      mediaS3Key: null,
      pillarContentItemId: null,
    };
    expect(hasDescriptableMedia(source, null)).toBe(true);
  });

  it("true when the source has its own media", () => {
    const source = {
      id: "s",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: "video.mp4",
      pillarContentItemId: null,
    };
    expect(hasDescriptableMedia(source, null)).toBe(true);
  });

  it("true when the pillar has a seed composition", () => {
    const source = {
      id: "s",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: null,
      pillarContentItemId: "pillar",
    };
    const pillar = {
      id: "pillar",
      title: null,
      descriptProjectId: "p",
      descriptProjectUrl: null,
      descriptSeedCompositionId: "seed",
      mediaS3Key: null,
    };
    expect(hasDescriptableMedia(source, pillar)).toBe(true);
  });

  it("true when the pillar has media (cold-import is possible)", () => {
    const source = {
      id: "s",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: null,
      pillarContentItemId: "pillar",
    };
    const pillar = {
      id: "pillar",
      title: null,
      descriptProjectId: null,
      descriptProjectUrl: null,
      descriptSeedCompositionId: null,
      mediaS3Key: "pillar.mp4",
    };
    expect(hasDescriptableMedia(source, pillar)).toBe(true);
  });

  it("false when there's no path to a composition", () => {
    const source = {
      id: "s",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: null,
      pillarContentItemId: null,
    };
    expect(hasDescriptableMedia(source, null)).toBe(false);
  });

  it("false when the pillar exists but has no seed and no media", () => {
    const source = {
      id: "s",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: null,
      pillarContentItemId: "pillar",
    };
    const pillar = {
      id: "pillar",
      title: null,
      descriptProjectId: "p",
      descriptProjectUrl: null,
      descriptSeedCompositionId: null,
      mediaS3Key: null,
    };
    expect(hasDescriptableMedia(source, pillar)).toBe(false);
  });
});

describe("loadPillarForSource", () => {
  it("returns null when source has no pillar", async () => {
    const result = await loadPillarForSource({ pillarContentItemId: null });
    expect(result).toBeNull();
  });

  it("loads the pillar row with the Descript-related columns", async () => {
    const pillar = await createTestProductionItem({
      sourceType: "original",
      descriptProjectId: "test-project",
      descriptSeedCompositionId: "test-seed",
      mediaS3Key: "pillar.mp4",
    });
    const result = await loadPillarForSource({
      pillarContentItemId: pillar.id,
    });
    expect(result).not.toBeNull();
    expect(result?.id).toBe(pillar.id);
    expect(result?.descriptProjectId).toBe("test-project");
    expect(result?.descriptSeedCompositionId).toBe("test-seed");
    expect(result?.mediaS3Key).toBe("pillar.mp4");
  });
});
