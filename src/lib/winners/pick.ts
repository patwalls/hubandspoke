/**
 * "Beat their usual" — which recent posts did better than their own normal.
 *
 * A post is judged against the median views of the same account + post type
 * over the last 90 days, not against the brand: a big account's average Short
 * would otherwise always outrank a small account's best one. The SQL in
 * `src/lib/db/winners.ts` fetches each recent post with its baseline; this
 * module decides who counts and in what order, so the rules are testable.
 */

export interface WinnerCandidate {
  id: string;
  title: string | null;
  views: number;
  /** Median views for the post's account + post type over the baseline window. */
  baselineMedian: number;
  /** How many posts that median is built from. */
  baselinePosts: number;
}

export interface Winner<T extends WinnerCandidate = WinnerCandidate> {
  item: T;
  /** views ÷ baselineMedian, one decimal. */
  lift: number;
}

/** Fewer baseline posts than this and the median is noise. */
export const MIN_BASELINE_POSTS = 5;
/** A post must do at least this much better than its usual to show. */
export const MIN_LIFT = 1.5;
/** A post this small can't "win" — 30 views against a median of 10 isn't news. */
export const MIN_VIEWS = 500;

export function pickWinners<T extends WinnerCandidate>(
  candidates: T[],
  { limit = 5 }: { limit?: number } = {},
): Winner<T>[] {
  return candidates
    .filter(
      (c) =>
        c.baselinePosts >= MIN_BASELINE_POSTS &&
        c.baselineMedian > 0 &&
        c.views >= MIN_VIEWS,
    )
    .map((c) => ({ item: c, lift: Math.round((c.views / c.baselineMedian) * 10) / 10 }))
    .filter((w) => w.lift >= MIN_LIFT)
    .sort((a, b) => b.lift - a.lift || b.item.views - a.item.views)
    .slice(0, limit);
}

/** "12×", "2.4×", "1,240×" — whole numbers past 10, one decimal below. */
export function formatLift(lift: number): string {
  const n = lift >= 10 ? Math.round(lift).toLocaleString("en-US") : lift.toFixed(1);
  return `${n}×`;
}
