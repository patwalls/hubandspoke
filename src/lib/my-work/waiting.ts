/**
 * How long a My Work row has sat in its current status (my-day M11). Pure,
 * so the thresholds are tested.
 *
 * Review is where posts stall: the median wait was ~12-24 h on the busiest
 * brands, while My Work's done-when is under 6 h. A row says "4h" / "3d" and
 * turns amber at 6 h and red at a day, so the oldest stand out without
 * opening anything.
 */

export type WaitingTone = "fresh" | "due" | "late";

export const DUE_AFTER_HOURS = 6;
export const LATE_AFTER_HOURS = 24;

export interface Waiting {
  label: string;
  tone: WaitingTone;
  hours: number;
}

export function waitingFor(since: Date | string | null | undefined, now: Date = new Date()): Waiting | null {
  if (!since) return null;
  const t = typeof since === "string" ? new Date(since) : since;
  if (Number.isNaN(t.getTime())) return null;
  const hours = Math.max(0, (now.getTime() - t.getTime()) / 3_600_000);
  const label =
    hours < 1
      ? `${Math.max(1, Math.floor(hours * 60))}m`
      : hours < 48
        ? `${Math.floor(hours)}h`
        : `${Math.floor(hours / 24)}d`;
  const tone: WaitingTone = hours >= LATE_AFTER_HOURS ? "late" : hours >= DUE_AFTER_HOURS ? "due" : "fresh";
  return { label, tone, hours };
}

/** Oldest wait first; rows with no known start keep their order, after the rest. */
export function sortByLongestWait<R extends { id: string }>(
  rows: R[],
  since: ReadonlyMap<string, Date>,
): R[] {
  return rows
    .map((r, i) => ({ r, i, t: since.get(r.id)?.getTime() }))
    .sort((a, b) => {
      if (a.t === undefined && b.t === undefined) return a.i - b.i;
      if (a.t === undefined) return 1;
      if (b.t === undefined) return -1;
      return a.t - b.t || a.i - b.i;
    })
    .map((x) => x.r);
}
