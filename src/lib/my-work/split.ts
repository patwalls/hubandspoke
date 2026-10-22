/**
 * How My Work sorts what's on someone's plate. Pure, so the rules are tested.
 *
 * - **Your turn**: items you're the editor on that are waiting on you —
 *   Assigned (edit it) or Ready To Publish (post it).
 * - **To review**: items in Review on a brand where you've moved something
 *   out of Review in the last 30 days. Nobody is assigned as a reviewer in the
 *   data, so the history is the assignment: the person who approved a brand's
 *   posts last month is the one who'll approve them this week. Includes your
 *   own items on that brand (some people approve their own).
 * - **Waiting on others**: the rest of your items (Review on a brand someone
 *   else approves, On Hold, Scheduled, …).
 */

export const YOUR_TURN_STATUSES = ["Assigned", "Ready To Publish"] as const;
export const REVIEW_STATUS = "Review";

export interface MyWorkRow {
  id: string;
  brand: string;
  status: string | null;
  editorUserId: string | null;
}

export interface MyWorkSplit<R extends MyWorkRow> {
  yourTurn: R[];
  toReview: R[];
  waitingOnOthers: R[];
}

/**
 * `mine` = items you're the editor on (not Published/Killed). `inReview` =
 * Review items on the brands you approve (`reviewBrands`), anyone's.
 */
export function splitMyWork<R extends MyWorkRow>(
  mine: R[],
  inReview: R[],
  reviewBrands: ReadonlySet<string>,
): MyWorkSplit<R> {
  const toReview = inReview.filter(
    (r) => r.status === REVIEW_STATUS && reviewBrands.has(r.brand),
  );
  const reviewIds = new Set(toReview.map((r) => r.id));
  const yourTurn: R[] = [];
  const waitingOnOthers: R[] = [];
  for (const r of mine) {
    if (reviewIds.has(r.id)) continue;
    if (r.status && (YOUR_TURN_STATUSES as readonly string[]).includes(r.status)) {
      yourTurn.push(r);
    } else {
      waitingOnOthers.push(r);
    }
  }
  return { yourTurn, toReview, waitingOnOthers };
}

/** The number on the header's My Work button. */
export function waitingCount(split: MyWorkSplit<MyWorkRow>): number {
  return split.yourTurn.length + split.toReview.length;
}
