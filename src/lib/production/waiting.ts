// "Waiting 5d" on the In Production list: how long a post has sat in a
// hand-off status, shown only once it is clearly stuck.
//
// Only the hand-off statuses count: Review (someone has to review it) and
// Ready To Publish (someone has to post it). In those, a typical post moves on
// within a day (Review median ~18 h, Ready To Publish ~0.4 h), so 3 days is
// stuck. Assigned is editing work (a long wait there is normal backlog) and
// Scheduled waits for its date by design, so neither is ever flagged — a tag
// on most rows would be noise, not a signal.

export const WAITING_STATUSES: ReadonlySet<string> = new Set([
  "Review",
  "Ready To Publish",
]);

export const WAITING_AFTER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Waiting {
  days: number;
  /** "In Review for 5 days, since Oct 27" — the tag's tooltip. */
  title: string;
}

/** Null unless the post has sat in a hand-off status for WAITING_AFTER_DAYS
 *  or more. `since` is when it entered its current status (ISO); a missing or
 *  unparseable time never flags. */
export function waitingInStatus(
  status: string | null | undefined,
  since: string | null | undefined,
  now: number = Date.now(),
): Waiting | null {
  if (!status || !WAITING_STATUSES.has(status) || !since) return null;
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now - t) / DAY_MS);
  if (days < WAITING_AFTER_DAYS) return null;
  const date = new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return { days, title: `In ${status} for ${days} days, since ${date}` };
}
