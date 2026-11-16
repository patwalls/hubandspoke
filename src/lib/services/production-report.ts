import { compressedCache } from "@/lib/compressed-cache";
import { getProductionPipeline } from "@/lib/db/queries";
import {
  buildViewPredictorContext,
  predictViews,
} from "@/lib/services/view-predictor";
import { loadFormatOdds } from "@/lib/services/clip-odds";
import { oddsKey } from "@/lib/clip-odds";
import { PRODUCTION_REPORT_TAG, productionReportTag } from "@/lib/production-report-tags";

/**
 * Production-pipeline report (the queue page's primary payload), 60s-cached.
 * Measured 1.5-2.7s per call even warm (pipeline query + view-predictor
 * context + per-item predictions) and it's fetched on every queue-page
 * mount. Same staleness rationale as the content report: triage data whose
 * inputs move via background sweeps. Shared by the API route, the queue
 * page's SSR, and /api/warm — one cache entry, gzipped because the busiest
 * brand outgrew Next's 2 MB ceiling on 2026-11-07 (2.4 MB raw, see
 * lib/compressed-cache.ts).
 */
export async function computeProductionReport(brand: string, excludeIdea: boolean) {
    const [items, ctx, odds] = await Promise.all([
      getProductionPipeline(brand, { excludeIdea }),
      buildViewPredictorContext(brand),
      // Fail-soft: the queue still renders without the odds chip.
      loadFormatOdds(brand).catch((err) => {
        console.warn(`[production-report] clip odds failed: ${err instanceof Error ? err.message : err}`);
        return new Map();
      }),
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
      // Clip-idea rows also carry their format's track record on this
      // account (lib/clip-odds.ts) — the queue orders a video's clips by it
      // and shows it as the "why" chip. ~150 bytes on clip rows only.
      const clipOdds =
        item.sourceClipIdeaId && item.format
          ? (odds.get(oddsKey(item.brand, item.format)) ?? null)
          : undefined;
      return clipOdds === undefined ? { ...item, prediction } : { ...item, prediction, clipOdds };
    });
    return { items: withPredictions };
}

type ProductionReport = Awaited<ReturnType<typeof computeProductionReport>>;

// One cache per brand so an edit can expire just its own brand (plus /all):
// unstable_cache tags are fixed when the cache is made, not per call. Until
// 2026-11-16 every edit anywhere expired every brand's report at once, and
// the after-edit re-warm rebuilt them one by one, so most brands sat cold
// for most of a minute after any edit (sentry-tx p95 6 s, p50 59 ms).
const perBrand = new Map<string, (excludeIdea: boolean) => Promise<ProductionReport>>();
// `brand` comes from the URL; don't let junk values grow the map forever.
const MAX_BRAND_CACHES = 200;

function brandCache(brand: string) {
  const hit = perBrand.get(brand);
  if (hit) return hit;
  const fn = compressedCache(
    async (excludeIdea: boolean) => computeProductionReport(brand, excludeIdea),
    ["production-report", brand],
    // The shared tag still expires every brand at once (writes that don't
    // say which brands they touched) — src/lib/production-report-tags.ts.
    { revalidate: 60, tags: [PRODUCTION_REPORT_TAG, productionReportTag(brand)] },
  );
  if (perBrand.size < MAX_BRAND_CACHES) perBrand.set(brand, fn);
  return fn;
}

export function getProductionReportCached(
  brand: string,
  excludeIdea: boolean,
): Promise<ProductionReport> {
  return brandCache(brand)(excludeIdea);
}
