// Pure types + tunable constants for the proven-format algorithm. Lives
// in its own module (with zero side-effects and no DB imports) so client
// components can `import` from here without dragging the server-only
// `format-proven.ts` (and its `@/lib/db` dep) into the browser bundle.

export type ProvenReason = "proven" | "testing" | "stale";

export interface FormatProvenStatus {
  isProven: boolean;
  reason: ProvenReason;
  itemCount: number;
  recentItemCount: number;
  formatMedian: number;
  peerMedian: number;
  hitCount: number;
  dominantPostType: string | null;
}

export interface ProvenSummary {
  proven: number;
  testing: number;
  stale: number;
}

export const PROVEN_WINDOW_DAYS = 180;
export const PROVEN_RECENT_WINDOW_DAYS = 90;
/** Path 1 ("consistency") volume floor. The format's typical post is
 *  expected to perform at peer baseline — small samples are too noisy
 *  to judge. */
export const PROVEN_MIN_ITEMS = 5;
/** Multiplier on the peer median that defines an "outlier hit." A post
 *  at this many times the peer median is unambiguously a winner. */
export const PROVEN_OUTLIER_MULTIPLIER = 3;
/** Path 2 ("repeatable hits") volume floor. High-volume clip-style
 *  formats produce a lot of misses; the right signal is hit rate, not
 *  median. Below this item count we can't tell. */
export const PROVEN_VOLUME_HIT_MIN_ITEMS = 10;
/** Path 2 hit threshold. A format that produces three or more outlier
 *  hits in 180 days is reliably minting winners, regardless of whether
 *  its median is at or below peer baseline. */
export const PROVEN_VOLUME_HIT_MIN_HITS = 3;
