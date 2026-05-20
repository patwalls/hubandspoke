import { format } from "date-fns";

/**
 * Returns "YYYY-MM-DD" for "today," picking whichever is later between
 * the caller's local day and UTC. Used as the inclusive upper bound on
 * the `production_items.published_date` filter because that column is a
 * Postgres `date` (TZ-naive) and the notion sync writes UTC dates. For a
 * US-Eastern user at 9pm 5/19 local, a post with `published_date =
 * 2026-05-20` (UTC midnight crossed) would otherwise be excluded by a
 * local-today upper bound. Taking the max keeps "today" honest in both
 * directions (works for users east and west of UTC).
 */
export function todayInclusiveOfUtc(): string {
  const now = new Date();
  const local = format(now, "yyyy-MM-dd");
  const utc = now.toISOString().slice(0, 10);
  return local > utc ? local : utc;
}
