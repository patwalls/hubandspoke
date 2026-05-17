import { describe, expect, it } from "vitest";

import {
  checkRepostReadiness,
  hasDescriptableMedia,
  hasDescriptableMediaForRepost,
  loadPillarForSource,
  resolveImportTarget,
  resolveImportTargetForRepost,
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

  it("false when source has its own (cropped) media but pillar has nothing — the bug we fixed", () => {
    // This is the Reel-to-X scenario. The source (a Reel) has its own
    // 9:16 export in mediaS3Key, but the pillar (the original long-form
    // video) has no archived media. Old behavior: hasDescriptableMedia
    // returned true on source.mediaS3Key alone, the task cold-imported
    // the source's cropped pixels, and Underlord produced lossy re-aspect
    // garbage. New behavior: source.mediaS3Key is IGNORED when there's an
    // upstream pillar — only the pillar's media is acceptable. Refusing
    // here surfaces as `blocked:needs_pillar_media:` to the UI.
    const source = {
      id: "reel",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: "final-reel-9-16.mp4",
      pillarContentItemId: "pillar",
    };
    const pillar = {
      id: "pillar",
      title: null,
      descriptProjectId: null,
      descriptProjectUrl: null,
      descriptSeedCompositionId: null,
      mediaS3Key: null,
    };
    expect(hasDescriptableMedia(source, pillar)).toBe(false);
  });
});

describe("resolveImportTarget", () => {
  it("returns the pillar when source has an upstream parent", () => {
    const source = {
      id: "reel",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: "final-reel.mp4",
      pillarContentItemId: "pillar",
    };
    const pillar = {
      id: "pillar",
      title: "Original Podcast",
      descriptProjectId: null,
      descriptProjectUrl: null,
      descriptSeedCompositionId: null,
      mediaS3Key: "podcast.mp4",
    };
    const target = resolveImportTarget(source, pillar);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("pillar");
    expect(target?.row.id).toBe("pillar");
    expect(target?.row.mediaS3Key).toBe("podcast.mp4");
  });

  it("returns the source as its own pillar when no upstream parent", () => {
    const source = {
      id: "yt-video",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: "raw-podcast.mp4",
      pillarContentItemId: null,
    };
    const target = resolveImportTarget(source, null);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("source-as-pillar");
    expect(target?.row.id).toBe("yt-video");
    expect(target?.row.mediaS3Key).toBe("raw-podcast.mp4");
  });

  it("returns null when source has pillarContentItemId set but caller didn't load the pillar", () => {
    const source = {
      id: "reel",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: null,
      pillarContentItemId: "pillar",
    };
    expect(resolveImportTarget(source, null)).toBeNull();
  });
});

describe("checkRepostReadiness", () => {
  it("OK when source has its own composition (case 1 path)", () => {
    expect(
      checkRepostReadiness({
        id: "s",
        descriptProjectId: "p",
        descriptCompositionId: "c",
        mediaS3Key: null,
        pillarContentItemId: null,
      }),
    ).toEqual({ ok: true });
  });

  it("OK when source has its own mediaS3Key (cold-import path)", () => {
    expect(
      checkRepostReadiness({
        id: "s",
        descriptProjectId: null,
        descriptCompositionId: null,
        mediaS3Key: "reel.mp4",
        pillarContentItemId: null,
      }),
    ).toEqual({ ok: true });
  });

  it("OK on a Reel derivative when source has its own media even though pillar has nothing — the case Pat hit", () => {
    // Source is a Reel clipped from a long-form pillar. Pillar has no
    // archived media and no Descript project. Cross-post would refuse,
    // but repost is same-aspect so the Reel's own cropped media is the
    // exact thing we want to re-air.
    expect(
      checkRepostReadiness({
        id: "reel",
        descriptProjectId: null,
        descriptCompositionId: null,
        mediaS3Key: "final-reel-9-16.mp4",
        pillarContentItemId: "pillar-with-no-media",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses with needs_source_media when source has neither composition nor media", () => {
    const result = checkRepostReadiness({
      id: "s",
      descriptProjectId: null,
      descriptCompositionId: null,
      mediaS3Key: null,
      pillarContentItemId: "pillar",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("needs_source_media");
    }
  });
});

describe("hasDescriptableMediaForRepost", () => {
  it("true with own composition", () => {
    expect(
      hasDescriptableMediaForRepost({
        id: "s",
        descriptProjectId: "p",
        descriptCompositionId: "c",
        mediaS3Key: null,
        pillarContentItemId: null,
      }),
    ).toBe(true);
  });

  it("true with own mediaS3Key", () => {
    expect(
      hasDescriptableMediaForRepost({
        id: "s",
        descriptProjectId: null,
        descriptCompositionId: null,
        mediaS3Key: "reel.mp4",
        pillarContentItemId: null,
      }),
    ).toBe(true);
  });

  it("false with neither — pillar state is irrelevant", () => {
    expect(
      hasDescriptableMediaForRepost({
        id: "s",
        descriptProjectId: null,
        descriptCompositionId: null,
        mediaS3Key: null,
        pillarContentItemId: "pillar",
      }),
    ).toBe(false);
  });
});

describe("resolveImportTargetForRepost", () => {
  it("returns source-as-pillar even when an upstream pillar exists", () => {
    // Cross-post resolveImportTarget would return the pillar here. Repost
    // intentionally ignores the pillar — the Reel's own pixels are the
    // right material.
    const target = resolveImportTargetForRepost({
      id: "reel",
      descriptProjectId: "p1",
      descriptCompositionId: null,
      descriptSeedCompositionId: "seed1",
      mediaS3Key: "reel.mp4",
      pillarContentItemId: "pillar-irrelevant",
    });
    expect(target.kind).toBe("source-as-pillar");
    expect(target.row.id).toBe("reel");
    expect(target.row.mediaS3Key).toBe("reel.mp4");
    expect(target.row.descriptProjectId).toBe("p1");
    expect(target.row.descriptSeedCompositionId).toBe("seed1");
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
