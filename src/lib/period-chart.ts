// Pure helpers behind the dashboard's chart views (period-chart.tsx).
// Kept free of React so the trend maths and the series cap are unit-testable.

/** A period whose end date is today or later is still filling up — the
 *  current week on the weekly view. Charts draw it dashed and trends leave
 *  it out, otherwise every brand looks like it's falling off a cliff on
 *  Monday. Returns the index of that period, or null. */
export function inProgressIndex(
  periods: { start: string; end: string }[],
  today: string,
): number | null {
  const last = periods.length - 1;
  if (last < 0) return null;
  const p = periods[last];
  return p.start <= today && p.end >= today ? last : null;
}

export type Trend =
  | { kind: "change"; pct: number; window: number }
  | { kind: "new"; window: number }
  | null;

/** Average of the last `window` complete periods against the `window`
 *  before them (window = up to 4, shrinking for short ranges). The
 *  in-progress period is excluded. null when there isn't enough history to
 *  say anything, or nothing happened in either window. */
export function periodTrend(values: number[], partialIndex: number | null): Trend {
  const complete =
    partialIndex === null ? values : values.filter((_, i) => i !== partialIndex);
  const window = Math.min(4, Math.floor(complete.length / 2));
  if (window < 1) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const recent = mean(complete.slice(-window));
  const prior = mean(complete.slice(-2 * window, -window));
  if (prior === 0) return recent > 0 ? { kind: "new", window } : null;
  return { kind: "change", pct: (recent - prior) / prior, window };
}

/** Number of categorical colour slots (--viz-1 … --viz-8). */
export const SERIES_SLOTS = 8;

/** Keep a chart at or under SERIES_SLOTS series: past that, the biggest
 *  (by `total`) SERIES_SLOTS - 1 stay and the rest fold into one "Other"
 *  entry built by `fold`. Survivors keep their incoming order so colours
 *  don't reshuffle when the metric tab changes the ranking. */
export function capSeries<T extends { total: number }>(
  series: T[],
  fold: (rest: T[]) => T,
): T[] {
  if (series.length <= SERIES_SLOTS) return series;
  const keep = new Set(
    [...series].sort((a, b) => b.total - a.total).slice(0, SERIES_SLOTS - 1),
  );
  const rest = series.filter((s) => !keep.has(s));
  return [...series.filter((s) => keep.has(s)), fold(rest)];
}
