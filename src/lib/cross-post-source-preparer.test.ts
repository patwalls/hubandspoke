import { describe, it, expect, vi } from "vitest";
import {
  createSourcePreparer,
  PREPARE_REUSE_MS,
  type PreparerDeps,
  type PreparerSource,
} from "./cross-post-source-preparer";

function deps(
  source: PreparerSource | null,
  over: Partial<PreparerDeps> = {},
): PreparerDeps & { enrich: ReturnType<typeof vi.fn> } {
  const enrich = vi.fn(
    () => new Promise((resolve) => setTimeout(resolve, 5)),
  );
  return {
    loadSource: async () => source,
    hasCleanOriginal: async () => false,
    hasCarouselRow: async () => false,
    isVideoBearing: (pt) => pt === "tiktok",
    enrich,
    ...over,
  } as PreparerDeps & { enrich: ReturnType<typeof vi.fn> };
}

const videoNoMedia: PreparerSource = {
  id: "s1",
  postType: "tiktok",
  mediaS3Key: null,
  enrichmentCompletedAt: new Date("2026-11-01"),
};

describe("createSourcePreparer", () => {
  it("parallel cross-posts of one source share ONE forced media enrichment", async () => {
    // The dialog fires one POST per target at once; each used to force its
    // own withMedia download (N credit charges, N × ~14 s).
    const d = deps(videoNoMedia);
    const prepare = createSourcePreparer(d);
    const results = await Promise.all([
      prepare("s1"),
      prepare("s1"),
      prepare("s1"),
      prepare("s1"),
    ]);
    expect(d.enrich).toHaveBeenCalledTimes(1);
    expect(d.enrich).toHaveBeenCalledWith("s1", { withMedia: true, force: true });
    expect(results.every((r) => r.enriched)).toBe(true);
  });

  it("a POST right after the warm-up finished joins it instead of re-forcing", async () => {
    let t = 1_000;
    const d = deps(videoNoMedia);
    const prepare = createSourcePreparer(d, () => t);
    await prepare("s1");
    t += PREPARE_REUSE_MS - 1;
    await prepare("s1");
    expect(d.enrich).toHaveBeenCalledTimes(1);
    t += 2;
    await prepare("s1");
    expect(d.enrich).toHaveBeenCalledTimes(2);
  });

  it("leaves a ready source alone", async () => {
    const d = deps({ ...videoNoMedia, mediaS3Key: "media/x.mp4" });
    const r = await createSourcePreparer(d)("s1");
    expect(d.enrich).not.toHaveBeenCalled();
    expect(r).toEqual({ hasCleanOriginal: false, enriched: false });
  });

  it("a clean original up the lineage means no download", async () => {
    const d = deps(videoNoMedia, { hasCleanOriginal: async () => true });
    const r = await createSourcePreparer(d)("s1");
    expect(d.enrich).not.toHaveBeenCalled();
    expect(r.hasCleanOriginal).toBe(true);
  });

  it("never-enriched text post: plain enrichment, no media, no force", async () => {
    const d = deps({ id: "s2", postType: "x", mediaS3Key: null, enrichmentCompletedAt: null });
    await createSourcePreparer(d)("s2");
    expect(d.enrich).toHaveBeenCalledWith("s2", { withMedia: undefined, force: false });
  });

  it("enrichment failure is fail-soft; a lookup failure is not cached", async () => {
    const logError = vi.fn();
    const d = deps(videoNoMedia, {
      enrich: vi.fn(async () => {
        throw new Error("scraper down");
      }),
      logError,
    });
    await expect(createSourcePreparer(d)("s1")).resolves.toEqual({
      hasCleanOriginal: false,
      enriched: true,
    });
    expect(logError).toHaveBeenCalledOnce();

    let calls = 0;
    const flaky = deps(videoNoMedia, {
      loadSource: async () => {
        calls += 1;
        if (calls === 1) throw new Error("db blip");
        return videoNoMedia;
      },
    });
    const prepare = createSourcePreparer(flaky);
    await expect(prepare("s1")).rejects.toThrow("db blip");
    await expect(prepare("s1")).resolves.toMatchObject({ enriched: true });
  });

  it("missing source: nothing to do", async () => {
    const d = deps(null);
    expect(await createSourcePreparer(d)("nope")).toEqual({
      hasCleanOriginal: false,
      enriched: false,
    });
  });
});
