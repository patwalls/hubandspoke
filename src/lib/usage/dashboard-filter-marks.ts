import { differenceInCalendarDays, parseISO, isValid } from "date-fns";

/**
 * Usage marks for a filter change on the brand dashboard (ContentReport).
 *
 * Why: a quarter of dashboard visits change a filter within the first minute,
 * but a view row is just `/[brand]` — we can't tell whether people re-pick the
 * same view every visit (→ remember it) or explore (→ leave it alone). These
 * marks answer that: `dashboard:filter:<key>:<value>`.
 *
 * Values stay low-cardinality and id-free: enum-ish keys keep their word-shaped
 * value; id/name keys (account, format) only say `set` or `all`; the date range
 * collapses to its length bucket.
 */
export type DashboardFilterValues = Record<string, string>;

/** Keys whose value is a short enum (platform slug, weekly/monthly, …). */
const VALUE_KEYS = [
  "platform",
  "postType",
  "channels",
  "source",
  "origin",
  "provenOnly",
  "viewType",
  "groupBy",
] as const;

/** Keys whose value is an id or a free name — record only set vs all. */
const SET_KEYS = ["accountId", "format"] as const;

const WORDISH = /^[a-z0-9_-]{1,32}$/i;

/** Length bucket of an inclusive start..end date range. */
export function rangeBucket(start: string, end: string): string {
  const s = parseISO(start);
  const e = parseISO(end);
  if (!isValid(s) || !isValid(e)) return "custom";
  const days = differenceInCalendarDays(e, s);
  if (days < 0) return "custom";
  if (days <= 7) return "7d";
  if (days <= 31) return "30d";
  if (days <= 95) return "90d";
  if (days <= 370) return "1y";
  return "longer";
}

export function dashboardFilterMarks(
  prev: DashboardFilterValues,
  next: DashboardFilterValues,
): string[] {
  const marks: string[] = [];
  for (const key of VALUE_KEYS) {
    if (prev[key] === next[key] || next[key] === undefined) continue;
    const v = next[key];
    marks.push(`dashboard:filter:${key}:${WORDISH.test(v) ? v.toLowerCase() : "other"}`);
  }
  for (const key of SET_KEYS) {
    if (prev[key] === next[key] || next[key] === undefined) continue;
    marks.push(`dashboard:filter:${key}:${next[key] === "all" ? "all" : "set"}`);
  }
  if (
    (prev.startDate !== next.startDate || prev.endDate !== next.endDate) &&
    next.startDate &&
    next.endDate
  ) {
    marks.push(`dashboard:filter:range:${rangeBucket(next.startDate, next.endDate)}`);
  }
  return marks;
}
