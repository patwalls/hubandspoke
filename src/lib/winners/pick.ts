/**
 * "Beat their usual" — which recent posts did better than their own normal.
 *
 * A post is judged against the median views of the same account + post type
 * over the last 90 days, not against the brand: a big account's average Short
 * would otherwise always outrank a small account's best one. The SQL in
 * `src/lib/db/winners.ts` fetches each recent post with its baseline; this
 * module decides who counts and in what order, so the rules are testable.
 *
 * Facebook, LinkedIn, Threads, Instagram photo posts and community posts have
 * no real view count — their "views" are likes × a fixed multiplier
 * (`view-estimator.ts`). Those are judged on likes against the usual likes,
 * with a likes floor: 11 likes estimates to ~1,800 "views" and would clear
 * the views floor while being nothing anyone would call a hit.
 */

export interface WinnerCandidate {
  id: string;
  title: string | null;
  views: number;
  /** Median views for the post's account + post type over the baseline window. */
  baselineMedian: number;
  /** How many posts that median is built from. */
  baselinePosts: number;
  /** "likes" when the post type has no real views (see the header). */
  metric?: "views" | "likes";
  likes?: number;
  /** Median likes for the same account + post type over the baseline window. */
  baselineLikesMedian?: number;
}

export interface Winner<T extends WinnerCandidate = WinnerCandidate> {
  item: T;
  /** views ÷ baselineMedian (likes ÷ baselineLikesMedian for "likes"), one decimal. */
  lift: number;
}

/** Fewer baseline posts than this and the median is noise. */
export const MIN_BASELINE_POSTS = 5;
/** A post must do at least this much better than its usual to show. */
export const MIN_LIFT = 1.5;
/** A post this small can't "win" — 30 views against a median of 10 isn't news. */
export const MIN_VIEWS = 500;
/** The same floor for posts judged on likes. */
export const MIN_LIKES = 25;

/** The numbers a candidate is judged on: real views, or likes when views are estimated. */
export function measure(c: WinnerCandidate): { value: number; usual: number; floor: number } {
  return c.metric === "likes"
    ? { value: c.likes ?? 0, usual: c.baselineLikesMedian ?? 0, floor: MIN_LIKES }
    : { value: c.views, usual: c.baselineMedian, floor: MIN_VIEWS };
}

export function pickWinners<T extends WinnerCandidate>(
  candidates: T[],
  { limit = 5 }: { limit?: number } = {},
): Winner<T>[] {
  return candidates
    .map((c) => ({ c, m: measure(c) }))
    .filter(({ c, m }) => c.baselinePosts >= MIN_BASELINE_POSTS && m.usual > 0 && m.value >= m.floor)
    .map(({ c, m }) => ({ item: c, lift: Math.round((m.value / m.usual) * 10) / 10 }))
    .filter((w) => w.lift >= MIN_LIFT)
    .sort((a, b) => b.lift - a.lift || b.item.views - a.item.views)
    .slice(0, limit);
}

/** "12×", "2.4×", "1,240×" — whole numbers past 10, one decimal below. */
export function formatLift(lift: number): string {
  const n = lift >= 10 ? Math.round(lift).toLocaleString("en-US") : lift.toFixed(1);
  return `${n}×`;
}
