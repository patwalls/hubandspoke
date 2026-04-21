/**
 * Predicted views for pre-published content.
 *
 * Log-space cohort blending: for a target item, we pull up to five cohorts of
 * historical published items (same pillar, same format+platform, same format,
 * same platform, brand-wide), compute a weighted log-median for each, and
 * blend them by a prior × sqrt(effective-N) weight. Output is a point
 * prediction plus a p25/p75 range derived from the blended log-IQR.
 *
 * Distinct from view-estimator.ts, which estimates *actual* views from likes
 * post-publication on platforms that don't expose real view counts. This
 * module predicts views for a piece of content that hasn't published yet.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

export type CohortKey = "A" | "B" | "C" | "D" | "E";

export type Confidence = "high" | "med" | "low";

export interface ViewPrediction {
  prediction: number | null;
  p25: number | null;
  p75: number | null;
  confidence: Confidence;
  cohortBreakdown: Array<{
    cohort: CohortKey;
    label: string;
    n: number;
    median: number;
    weight: number;
  }>;
  reason?: "insufficient_data";
}

interface HistoricalItem {
  id: string;
  views: number;
  format: string | null;
  primaryPlatform: string | null;
  pillarContentItemId: string | null;
  publishedDate: string | null;
  viewsEstimated: boolean;
}

export interface ViewPredictorContext {
  brand: string;
  generatedAt: Date;
  items: HistoricalItem[];
  byPillar: Map<string, HistoricalItem[]>;
  byFormatPlatform: Map<string, HistoricalItem[]>;
  byFormat: Map<string, HistoricalItem[]>;
  byPlatform: Map<string, HistoricalItem[]>;
}

export interface TargetItem {
  id: string;
  format: string | null;
  platforms: string[] | null;
  pillarContentItemId: string | null;
}

const NOISE_FLOOR_VIEWS = 10;
const FRESHNESS_EXCLUDE_HOURS = 48;
const RECENCY_HALF_LIFE_DAYS = 180;
const ESTIMATED_WEIGHT = 0.5;
const MAX_N_EFF_FOR_WEIGHT = 20;
const LOG_IQR_FLOOR = Math.log(2);
const MIN_BRAND_SAMPLE = 3;

const COHORT_PRIORS: Record<CohortKey, number> = {
  A: 3.0,
  B: 2.0,
  C: 1.0,
  D: 0.6,
  E: 0.3,
};

const COHORT_LABELS: Record<CohortKey, string> = {
  A: "Same pillar",
  B: "Same format + platform",
  C: "Same format",
  D: "Same platform",
  E: "Brand-wide",
};

function formatPlatformKey(format: string, platform: string): string {
  return `${format.toLowerCase()}|${platform.toLowerCase()}`;
}

function normalizeFormat(format: string | null): string | null {
  return format ? format.toLowerCase() : null;
}

function normalizePlatform(platform: string | null): string | null {
  return platform ? platform.toLowerCase() : null;
}

function primaryPlatformOf(platforms: string[] | null): string | null {
  if (!platforms || platforms.length === 0) return null;
  return platforms[0] ?? null;
}

/**
 * Load the full brand-scoped published history once per request. Small payload
 * (typically < a few thousand rows), no pagination. Callers pass the resulting
 * context into `predictViews` for each target item they want to score.
 */
export async function buildViewPredictorContext(
  brand: string
): Promise<ViewPredictorContext> {
  const rows = await db
    .select({
      id: productionItems.id,
      views: productionItems.views,
      format: productionItems.format,
      platform: productionItems.platform,
      pillarContentItemId: productionItems.pillarContentItemId,
      publishedDate: productionItems.publishedDate,
      viewsEstimated: productionItems.viewsEstimated,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.views)
      )
    );

  const now = Date.now();
  const freshnessCutoff = now - FRESHNESS_EXCLUDE_HOURS * 3600 * 1000;

  const items: HistoricalItem[] = [];
  for (const r of rows) {
    if (r.views == null || r.views < NOISE_FLOOR_VIEWS) continue;
    if (r.publishedDate) {
      const pub = Date.parse(r.publishedDate);
      if (!Number.isNaN(pub) && pub > freshnessCutoff) continue;
    }
    items.push({
      id: r.id,
      views: r.views,
      format: r.format,
      primaryPlatform: primaryPlatformOf(r.platform ?? null),
      pillarContentItemId: r.pillarContentItemId,
      publishedDate: r.publishedDate,
      viewsEstimated: r.viewsEstimated ?? false,
    });
  }

  const byPillar = new Map<string, HistoricalItem[]>();
  const byFormatPlatform = new Map<string, HistoricalItem[]>();
  const byFormat = new Map<string, HistoricalItem[]>();
  const byPlatform = new Map<string, HistoricalItem[]>();

  for (const item of items) {
    if (item.pillarContentItemId) {
      const bucket = byPillar.get(item.pillarContentItemId) ?? [];
      bucket.push(item);
      byPillar.set(item.pillarContentItemId, bucket);
    }
    const fmt = normalizeFormat(item.format);
    const plat = normalizePlatform(item.primaryPlatform);
    if (fmt) {
      const bucket = byFormat.get(fmt) ?? [];
      bucket.push(item);
      byFormat.set(fmt, bucket);
    }
    if (plat) {
      const bucket = byPlatform.get(plat) ?? [];
      bucket.push(item);
      byPlatform.set(plat, bucket);
    }
    if (fmt && plat) {
      const key = formatPlatformKey(fmt, plat);
      const bucket = byFormatPlatform.get(key) ?? [];
      bucket.push(item);
      byFormatPlatform.set(key, bucket);
    }
  }

  return {
    brand,
    generatedAt: new Date(now),
    items,
    byPillar,
    byFormatPlatform,
    byFormat,
    byPlatform,
  };
}

function weightedQuantile(
  logs: number[],
  weights: number[],
  q: number
): number {
  const paired = logs
    .map((v, i) => ({ v, w: weights[i]! }))
    .filter((p) => p.w > 0)
    .sort((a, b) => a.v - b.v);
  if (paired.length === 0) return 0;
  const totalW = paired.reduce((s, p) => s + p.w, 0);
  if (totalW <= 0) return paired[Math.floor(paired.length / 2)]!.v;
  const target = q * totalW;
  let cum = 0;
  for (const p of paired) {
    cum += p.w;
    if (cum >= target) return p.v;
  }
  return paired[paired.length - 1]!.v;
}

function itemWeight(item: HistoricalItem, now: number): number {
  let recencyW = 1;
  if (item.publishedDate) {
    const pub = Date.parse(item.publishedDate);
    if (!Number.isNaN(pub)) {
      const ageDays = Math.max(0, (now - pub) / (86400 * 1000));
      recencyW = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    }
  }
  const estW = item.viewsEstimated ? ESTIMATED_WEIGHT : 1.0;
  return recencyW * estW;
}

interface CohortStats {
  cohort: CohortKey;
  nEff: number;
  logMed: number;
  logIQR: number;
  allEstimated: boolean;
}

function summarizeCohort(
  cohort: CohortKey,
  items: HistoricalItem[],
  now: number
): CohortStats | null {
  if (items.length === 0) return null;
  const logs: number[] = [];
  const weights: number[] = [];
  let allEstimated = true;
  for (const it of items) {
    const w = itemWeight(it, now);
    if (w <= 0) continue;
    logs.push(Math.log(Math.max(it.views, 1)));
    weights.push(w);
    if (!it.viewsEstimated) allEstimated = false;
  }
  const nEff = weights.reduce((s, w) => s + w, 0);
  if (nEff < 1) return null;
  const logMed = weightedQuantile(logs, weights, 0.5);
  const logP25 = weightedQuantile(logs, weights, 0.25);
  const logP75 = weightedQuantile(logs, weights, 0.75);
  const logIQR = Math.max(logP75 - logP25, LOG_IQR_FLOOR);
  return { cohort, nEff, logMed, logIQR, allEstimated };
}

function collectCohorts(
  target: TargetItem,
  ctx: ViewPredictorContext
): Array<{ cohort: CohortKey; items: HistoricalItem[] }> {
  const primaryPlatform = primaryPlatformOf(target.platforms);
  const fmt = normalizeFormat(target.format);
  const plat = normalizePlatform(primaryPlatform);

  const out: Array<{ cohort: CohortKey; items: HistoricalItem[] }> = [];

  if (target.pillarContentItemId) {
    const siblings = (ctx.byPillar.get(target.pillarContentItemId) ?? [])
      .filter((it) => it.id !== target.pillarContentItemId)
      .filter((it) => it.id !== target.id)
      .filter((it) => normalizeFormat(it.format) !== fmt);
    out.push({ cohort: "A", items: siblings });
  }

  if (fmt && plat) {
    const items = (ctx.byFormatPlatform.get(formatPlatformKey(fmt, plat)) ?? [])
      .filter((it) => it.id !== target.id);
    out.push({ cohort: "B", items });
  }

  if (fmt) {
    const items = (ctx.byFormat.get(fmt) ?? []).filter(
      (it) => it.id !== target.id
    );
    out.push({ cohort: "C", items });
  }

  if (plat) {
    const items = (ctx.byPlatform.get(plat) ?? []).filter(
      (it) => it.id !== target.id
    );
    out.push({ cohort: "D", items });
  }

  out.push({
    cohort: "E",
    items: ctx.items.filter((it) => it.id !== target.id),
  });

  return out;
}

/**
 * Log-space cohort blending. See file header for the algorithm. Pure function
 * over the pre-built context — caller can call this repeatedly to score many
 * items without hitting the DB again.
 */
export function predictViews(
  target: TargetItem,
  ctx: ViewPredictorContext
): ViewPrediction {
  const now = ctx.generatedAt.getTime();
  const rawCohorts = collectCohorts(target, ctx);
  const summaries: CohortStats[] = [];
  for (const { cohort, items } of rawCohorts) {
    const s = summarizeCohort(cohort, items, now);
    if (s) summaries.push(s);
  }

  if (summaries.length === 0) {
    // No cohort had enough weight. Fallback to brand median (ignoring filters).
    if (ctx.items.length < MIN_BRAND_SAMPLE) {
      return {
        prediction: null,
        p25: null,
        p75: null,
        confidence: "low",
        cohortBreakdown: [],
        reason: "insufficient_data",
      };
    }
    const fallback = summarizeCohort("E", ctx.items, now);
    if (!fallback) {
      return {
        prediction: null,
        p25: null,
        p75: null,
        confidence: "low",
        cohortBreakdown: [],
        reason: "insufficient_data",
      };
    }
    summaries.push(fallback);
  }

  let totalW = 0;
  for (const s of summaries) {
    const n = Math.min(s.nEff, MAX_N_EFF_FOR_WEIGHT);
    s.nEff = s.nEff; // keep original nEff for display
    const w = COHORT_PRIORS[s.cohort] * Math.sqrt(n);
    (s as CohortStats & { _w: number })._w = w;
    totalW += w;
  }

  const logMedBlended =
    summaries.reduce(
      (acc, s) => acc + (s as CohortStats & { _w: number })._w * s.logMed,
      0
    ) / totalW;
  const logIQRBlended =
    summaries.reduce(
      (acc, s) => acc + (s as CohortStats & { _w: number })._w * s.logIQR,
      0
    ) / totalW;

  const prediction = Math.round(Math.exp(logMedBlended));
  const p25 = Math.round(Math.exp(logMedBlended - logIQRBlended / 2));
  const p75 = Math.round(Math.exp(logMedBlended + logIQRBlended / 2));

  // Confidence: use the dominant (highest-prior) cohort with data.
  const dominant = summaries
    .slice()
    .sort((a, b) => COHORT_PRIORS[b.cohort] - COHORT_PRIORS[a.cohort])[0]!;
  const totalN = summaries.reduce((s, c) => s + c.nEff, 0);

  let confidence: Confidence;
  if (
    (dominant.cohort === "A" || dominant.cohort === "B") &&
    dominant.nEff >= 3 &&
    totalN >= 5
  ) {
    confidence = "high";
  } else if (
    (dominant.cohort === "A" ||
      dominant.cohort === "B" ||
      dominant.cohort === "C") &&
    dominant.nEff >= 2
  ) {
    confidence = "med";
  } else if (totalN >= 4) {
    confidence = "med";
  } else {
    confidence = "low";
  }

  // If every contributing cohort is made entirely of estimated-views items,
  // the inputs themselves are already multiplier-derived — trust less.
  if (summaries.every((s) => s.allEstimated)) {
    confidence = confidence === "high" ? "med" : "low";
  }

  return {
    prediction,
    p25,
    p75,
    confidence,
    cohortBreakdown: summaries.map((s) => ({
      cohort: s.cohort,
      label: COHORT_LABELS[s.cohort],
      n: Number(s.nEff.toFixed(2)),
      median: Math.round(Math.exp(s.logMed)),
      weight:
        Math.round(
          ((s as CohortStats & { _w: number })._w / totalW) * 1000
        ) / 1000,
    })),
  };
}
