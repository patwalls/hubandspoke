import { describe, it, expect, vi } from "vitest";

// Capture what each brand's report cache is tagged with.
const made = vi.hoisted(() => [] as { keyParts: string[]; tags: string[] }[]);
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown, keyParts: string[], opts: { tags: string[] }) => {
    made.push({ keyParts, tags: opts.tags });
    return fn;
  },
}));
vi.mock("@/lib/db/queries", () => ({ getProductionPipeline: vi.fn(async () => []) }));
vi.mock("@/lib/services/view-predictor", () => ({
  buildViewPredictorContext: vi.fn(async () => ({})),
  predictViews: vi.fn(() => null),
}));
vi.mock("@/lib/services/clip-odds", () => ({ loadFormatOdds: vi.fn(async () => new Map()) }));

import { getProductionReportCached } from "./production-report";
import {
  PRODUCTION_REPORT_TAG,
  productionReportTag,
  productionReportTagsToExpire,
} from "@/lib/production-report-tags";

describe("getProductionReportCached — one cache per brand", () => {
  it("tags each brand's report with its own tag, so one brand's edit leaves the others warm", async () => {
    await getProductionReportCached("starter-story", true);
    await getProductionReportCached("matg", true);
    await getProductionReportCached("starter-story", false);

    expect(made).toHaveLength(2); // reused per brand, not one per call
    const ss = made.find((m) => m.keyParts.includes("starter-story"))!;
    const matg = made.find((m) => m.keyParts.includes("matg"))!;
    expect(ss.tags).toEqual([PRODUCTION_REPORT_TAG, productionReportTag("starter-story")]);

    const expired = new Set(productionReportTagsToExpire(["starter-story"]));
    expect(ss.tags.some((t) => expired.has(t))).toBe(true);
    expect(matg.tags.some((t) => expired.has(t))).toBe(false);
    // A write that names no brand still reaches every brand's cache.
    const all = new Set(productionReportTagsToExpire(null));
    expect(matg.tags.some((t) => all.has(t))).toBe(true);
  });

  it("the /all report goes cold with any brand's edit", async () => {
    await getProductionReportCached("all", true);
    const allCache = made.find((m) => m.keyParts.includes("all"))!;
    const expired = new Set(productionReportTagsToExpire(["matg"]));
    expect(allCache.tags.some((t) => expired.has(t))).toBe(true);
  });
});

describe("getProductionReportCached — slow inputs shared", () => {
  it("both keys of a brand (queue + In Production) load the view history and odds once", async () => {
    const { buildViewPredictorContext } = await import("@/lib/services/view-predictor");
    const { loadFormatOdds } = await import("@/lib/services/clip-odds");
    vi.mocked(buildViewPredictorContext).mockClear();
    vi.mocked(loadFormatOdds).mockClear();
    // A cold report after an edit used to rebuild both from every published
    // row of the brand, for each key, every time.
    await getProductionReportCached("shared-inputs-brand", true);
    await getProductionReportCached("shared-inputs-brand", false);
    await getProductionReportCached("shared-inputs-brand", true);
    expect(vi.mocked(buildViewPredictorContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadFormatOdds)).toHaveBeenCalledTimes(1);
  });
});
