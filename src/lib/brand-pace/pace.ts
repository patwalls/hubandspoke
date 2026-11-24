/**
 * "Brands this week" on /all (projects: brands-at-a-glance M1). People who
 * check several brands flip brand dashboards for ~10 s each to read one
 * thing: is this brand on pace this week? This module decides that from
 * numbers the brand dashboard already shows (posts published this week, the
 * brand's weekly goal, the same point of last week).
 *
 * Pure — the query lives in `./query.ts`.
 */

export type Pace = "behind" | "on" | "ahead" | "quiet";

export interface BrandWeek {
  slug: string;
  label: string;
  /** Published posts since this brand's week started. */
  posts: number;
  /** Published posts by the same moment of last week. */
  priorPosts: number;
  /** Views on this week's posts so far. */
  views: number;
  weeklyGoal: number | null;
  /** 0..1 — how far into this brand's week we are. */
  weekFraction: number;
}

export interface BrandPaceRow extends BrandWeek {
  pace: Pace;
  /** What `posts` is measured against: the goal prorated, else last week. */
  expected: number;
  basis: "goal" | "last-week";
}

const BEHIND = 0.8;
const AHEAD = 1.2;

export function paceOf(w: BrandWeek): BrandPaceRow {
  const hasGoal = w.weeklyGoal != null && w.weeklyGoal > 0;
  const expected = hasGoal ? (w.weeklyGoal as number) * clamp01(w.weekFraction) : w.priorPosts;
  const basis = hasGoal ? "goal" : "last-week";
  // Nothing expected yet (early in the week, or a brand that posted nothing
  // by now last week) and nothing posted: not a signal either way.
  if (expected < 1) {
    return { ...w, expected, basis, pace: w.posts > 0 ? "ahead" : "quiet" };
  }
  const ratio = w.posts / expected;
  const pace: Pace = ratio < BEHIND ? "behind" : ratio > AHEAD ? "ahead" : "on";
  return { ...w, expected, basis, pace };
}

const ORDER: Record<Pace, number> = { behind: 0, on: 1, ahead: 2, quiet: 3 };

/** Off-pace brands first (furthest behind on top), quiet brands last. */
export function sortByPace(rows: BrandPaceRow[]): BrandPaceRow[] {
  return [...rows].sort((a, b) => {
    if (ORDER[a.pace] !== ORDER[b.pace]) return ORDER[a.pace] - ORDER[b.pace];
    const ra = a.expected > 0 ? a.posts / a.expected : Infinity;
    const rb = b.expected > 0 ? b.posts / b.expected : Infinity;
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label);
  });
}

/** The collapsed line: "2 behind pace · 5 on pace or ahead". */
export function paceSummary(rows: BrandPaceRow[]): string {
  const behind = rows.filter((r) => r.pace === "behind").length;
  const fine = rows.filter((r) => r.pace === "on" || r.pace === "ahead").length;
  const parts: string[] = [];
  if (behind > 0) parts.push(`${behind} behind pace`);
  if (fine > 0) parts.push(`${fine} on pace${behind > 0 ? "" : " or ahead"}`);
  if (parts.length === 0) return "nothing published yet";
  return parts.join(" · ");
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
