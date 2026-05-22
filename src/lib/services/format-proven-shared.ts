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
export const PROVEN_MIN_ITEMS = 5;
export const PROVEN_OUTLIER_MULTIPLIER = 3;
