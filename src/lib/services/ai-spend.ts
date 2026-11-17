/**
 * AI spend by feature and by day, from `llm_calls` (one row per billed model
 * call, written by src/lib/llm/metered*.ts). Dollars are estimated here, at
 * read time, from src/lib/llm/prices.ts.
 *
 * The DB read groups by day × provider × feature × model (a few hundred rows
 * for 30 days, whatever the call volume); `summarizeAiSpend` is the pure
 * half — the admin AI-spend page and the spike line in the morning email
 * (projects M3/M4) both read its shape.
 */
import { gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { llmCalls } from "@/lib/db/schema";
import { estimateCostUsd, type MeteredUsage } from "@/lib/llm/prices";

/** One (day, provider, feature, model) group from llm_calls. */
export interface AiSpendRow extends MeteredUsage {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  provider: string;
  feature: string;
  calls: number;
}

export interface AiSpendFeature {
  feature: string;
  provider: string;
  calls: number;
  /** Estimated USD of the priced calls. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  /** Models this feature used, most calls first. */
  models: string[];
  /** Calls whose model has no price yet (their cost is not in costUsd). */
  unpricedCalls: number;
}

export interface AiSpendSummary {
  totalCostUsd: number;
  totalCalls: number;
  byProvider: { provider: string; costUsd: number; calls: number }[];
  /** Costliest first; ties by calls. */
  byFeature: AiSpendFeature[];
  /** Every day in the window, oldest first, zero-filled. */
  byDay: { day: string; costUsd: number; calls: number }[];
  /** Models seen without a price row — add them to prices.ts. */
  unpricedModels: string[];
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Pure: roll the grouped rows up for a window of `days` ending `now`. */
export function summarizeAiSpend(
  rows: AiSpendRow[],
  opts: { days: number; now?: Date },
): AiSpendSummary {
  const now = opts.now ?? new Date();
  const features = new Map<string, AiSpendFeature & { modelCalls: Map<string, number> }>();
  const providers = new Map<string, { provider: string; costUsd: number; calls: number }>();
  const days = new Map<string, { day: string; costUsd: number; calls: number }>();
  const unpriced = new Set<string>();

  for (let i = opts.days - 1; i >= 0; i--) {
    const day = utcDay(new Date(now.getTime() - i * 86_400_000));
    days.set(day, { day, costUsd: 0, calls: 0 });
  }

  let totalCostUsd = 0;
  let totalCalls = 0;
  for (const r of rows) {
    const cost = estimateCostUsd(r);
    if (cost === null) unpriced.add(r.model);
    const usd = cost ?? 0;
    totalCostUsd += usd;
    totalCalls += r.calls;

    const key = `${r.provider}\u0000${r.feature}`;
    let f = features.get(key);
    if (!f) {
      f = {
        feature: r.feature,
        provider: r.provider,
        calls: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 0,
        models: [],
        unpricedCalls: 0,
        modelCalls: new Map(),
      };
      features.set(key, f);
    }
    f.calls += r.calls;
    f.costUsd += usd;
    f.inputTokens += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    f.outputTokens += r.outputTokens;
    f.audioSeconds += r.audioSeconds;
    if (cost === null) f.unpricedCalls += r.calls;
    f.modelCalls.set(r.model, (f.modelCalls.get(r.model) ?? 0) + r.calls);

    const p = providers.get(r.provider) ?? { provider: r.provider, costUsd: 0, calls: 0 };
    p.costUsd += usd;
    p.calls += r.calls;
    providers.set(r.provider, p);

    // Rows outside the window (clock skew, a caller's wider query) still
    // count in the totals but don't grow the day series.
    const d = days.get(r.day);
    if (d) {
      d.costUsd += usd;
      d.calls += r.calls;
    }
  }

  const byFeature = [...features.values()]
    .map(({ modelCalls, ...f }) => ({
      ...f,
      models: [...modelCalls.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  return {
    totalCostUsd,
    totalCalls,
    byProvider: [...providers.values()].sort((a, b) => b.costUsd - a.costUsd),
    byFeature,
    byDay: [...days.values()],
    unpricedModels: [...unpriced].sort(),
  };
}

/** AI spend for the last `days` UTC days (today included). */
export async function getAiSpendSummary(days = 30, now = new Date()): Promise<AiSpendSummary> {
  const since = new Date(`${utcDay(new Date(now.getTime() - (days - 1) * 86_400_000))}T00:00:00Z`);
  const day = sql<string>`to_char(${llmCalls.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      provider: llmCalls.provider,
      feature: llmCalls.feature,
      model: llmCalls.model,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens}), 0)::bigint`,
      cacheWriteTokens: sql<number>`coalesce(sum(${llmCalls.cacheWriteTokens}), 0)::bigint`,
      audioSeconds: sql<number>`coalesce(sum(${llmCalls.audioSeconds}), 0)::float8`,
    })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, since))
    .groupBy(day, llmCalls.provider, llmCalls.feature, llmCalls.model);
  // postgres.js returns bigint as string; make every number a number.
  return summarizeAiSpend(
    rows.map((r) => ({
      ...r,
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
      audioSeconds: Number(r.audioSeconds),
    })),
    { days, now },
  );
}
