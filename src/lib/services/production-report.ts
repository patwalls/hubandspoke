import { unstable_cache } from "next/cache";
import { getProductionPipeline } from "@/lib/db/queries";
import {
  buildViewPredictorContext,
  predictViews,
} from "@/lib/services/view-predictor";

/**
 * Production-pipeline report (the queue page's primary payload), 60s-cached.
 * Measured 1.5-2.7s per call even warm (pipeline query + view-predictor
 * context + per-item predictions) and it's fetched on every queue-page
 * mount. Same staleness rationale as the content report: triage data whose
 * inputs move via background sweeps. Shared by the API route, the queue
 * page's SSR, and /api/warm — one cache entry (~1.05 MB, under Next's 2 MB
 * unstable_cache ceiling).
 */
export async function computeProductionReport(brand: string, excludeIdea: boolean) {
    const [items, ctx] = await Promise.all([
      getProductionPipeline(brand, { excludeIdea }),
      buildViewPredictorContext(brand),
    ]);
    // Every unpublished row shows the history-based prediction (medians of
    // real views: same pillar, same format + platform, … with a p25–p75
    // range) — clip-idea rows too. Until 2026-11-07 clip rows swapped in the
    // clip writer's own `clip_ideas.estimated_views` as "high confidence".
    // Checked against the 473 idea clips that published
    // (docs/build/sql/clip-views.sql): that number was off ~10× at the median,
    // >3× too high on 86% of clips, and unrelated to which clips did better
    // within an account (corr 0.05); the brand + format + platform 90-day
    // median was off ~1.5×. Don't bring the override back without beating
    // that query.
    const withPredictions = items.map((item) => {
      if (item.status === "Published") return item;
      const prediction = predictViews(
        {
          id: item.id,
          format: item.format,
          platforms: item.platform,
          pillarContentItemId: item.pillarContentItemId ?? null,
        },
        ctx
      );
      return { ...item, prediction };
    });
    return { items: withPredictions };
}

export const getProductionReportCached = unstable_cache(
  async (brand: string, excludeIdea: boolean) =>
    computeProductionReport(brand, excludeIdea),
  ["production-report"],
  { revalidate: 60, tags: ["production-report"] },
);
