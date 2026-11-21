/**
 * How long someone waited for a list that had nothing to show yet, as a
 * coarse bucket that fits in a usage mark (`production:wait:1-3s`).
 *
 * usage_events has no value column, so a wait is recorded as one of three
 * marks. GlitchTip's transaction groups can't answer "how long do people
 * wait now" (their counts and p95s barely move day to day), so the
 * production-instant project reads these marks instead: share of
 * `:under-1s` over 7 days.
 */
export type WaitBucket = "under-1s" | "1-3s" | "3s-plus";

export function waitBucket(ms: number): WaitBucket {
  if (!Number.isFinite(ms) || ms < 1_000) return "under-1s";
  if (ms < 3_000) return "1-3s";
  return "3s-plus";
}
