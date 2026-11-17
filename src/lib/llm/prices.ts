/**
 * What an `llm_calls` row cost, estimated at read time (metered.ts records
 * tokens, never dollars, so a price change never rewrites history).
 *
 * Prices are list prices in USD, first-party API, checked 2026-11-17. A model
 * that isn't here is "unpriced": its calls and tokens still count, its cost is
 * `null`, and the spend summary names it so someone adds the row. Don't guess
 * a price to make the total look complete: an unpriced model is honest, a
 * wrong price isn't.
 *
 * Claude: cache reads and 5-minute cache writes have their own rates (writes
 * are 1.25× input). Haiku 5.5's rate is for prompts up to 100K tokens; the
 * app's calls are far below that. OpenAI whisper-1 bills audio by the minute.
 */

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** USD per 1M cache-read input tokens (defaults to inputPerM × 0.1). */
  cacheReadPerM?: number;
  /** USD per 1M cache-write input tokens (defaults to inputPerM × 1.25). */
  cacheWritePerM?: number;
  /** USD per minute of audio, for duration-billed models (whisper-1). */
  audioPerMin?: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 },
  "claude-sonnet-5-5": { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 },
  "claude-haiku-5-5": { inputPerM: 0.1, outputPerM: 0.5 },
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5 },
  "whisper-1": { inputPerM: 0, outputPerM: 0, audioPerMin: 0.006 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
};

// Dated snapshots (`claude-haiku-4-5-20251001`, `gpt-4o-mini-2024-07-18`)
// bill like their alias.
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The price row for a model id as the API reported it; null when unpriced. */
export function priceFor(model: string): ModelPrice | null {
  const id = model.trim().toLowerCase();
  return MODEL_PRICES[id] ?? MODEL_PRICES[id.replace(DATE_SUFFIX, "")] ?? null;
}

export interface MeteredUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  audioSeconds: number;
}

/** Estimated USD for some usage of one model; null when the model is unpriced. */
export function estimateCostUsd(u: MeteredUsage): number | null {
  const p = priceFor(u.model);
  if (!p) return null;
  const perM = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  return (
    perM(u.inputTokens, p.inputPerM) +
    perM(u.outputTokens, p.outputPerM) +
    perM(u.cacheReadTokens, p.cacheReadPerM ?? p.inputPerM * 0.1) +
    perM(u.cacheWriteTokens, p.cacheWritePerM ?? p.inputPerM * 1.25) +
    (u.audioSeconds / 60) * (p.audioPerMin ?? 0)
  );
}
