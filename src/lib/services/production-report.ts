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
async function computeProductionReport(brand: string, excludeIdea: boolean) {
    const [items, ctx] = await Promise.all([
      getProductionPipeline(brand, { excludeIdea }),
      buildViewPredictorContext(brand),
    ]);
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
      // For clip rows, prefer the LLM's per-clip estimate over the generic
      // format-based predictor. The LLM reads the actual transcript chunk
      // and the brand's top-performer hooks, so it has strictly more signal
      // than the format median. Wrap it into the same ViewPrediction shape
      // so the UI doesn't need a special-case render path.
      if (
        item.sourceClipIdeaId != null &&
        item.clipEstimatedViews != null &&
        prediction
      ) {
        const est = item.clipEstimatedViews;
        return {
          ...item,
          prediction: {
            ...prediction,
            prediction: est,
            p25: est,
            p75: est,
            confidence: "high" as const,
            cohortBreakdown: [],
          },
        };
      }
      return { ...item, prediction };
    });
    return { items: withPredictions };
}

export const getProductionReportCached = unstable_cache(
  async (brand: string, excludeIdea: boolean) =>
    computeProductionReport(brand, excludeIdea),
  ["production-report"],
  { revalidate: 60 },
);
