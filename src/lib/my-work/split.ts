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
 *
 * Not on anyone's plate: finished items (Published, Killed), Ideas, and items
 * with no status. Ideas are the backlog — clip-idea generation makes hundreds
 * per pillar and gives them the pillar's editor (or whoever clicked
 * Generate), so counting them buried real work under thousands of rows.
 */

export const YOUR_TURN_STATUSES = ["Assigned", "Ready To Publish"] as const;
export const OFF_PLATE_STATUSES = ["Published", "Killed", "Idea"] as const;

export function isOnPlate(status: string | null): boolean {
  return status !== null && !(OFF_PLATE_STATUSES as readonly string[]).includes(status);
}
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
    if (reviewIds.has(r.id) || !isOnPlate(r.status)) continue;
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

/** Which post a row was made from: the post it cross-posts / reposts, or the
 *  video it is a derivative of. Two rows with a shared link are siblings. */
export interface SourceLinks {
  repostedFromItemId?: string | null;
  pillarContentItemId?: string | null;
}

export function isSibling(row: SourceLinks, of: SourceLinks | null): boolean {
  if (!of) return false;
  return (
    (!!of.repostedFromItemId && row.repostedFromItemId === of.repostedFromItemId) ||
    (!!of.pillarContentItemId && row.pillarContentItemId === of.pillarContentItemId)
  );
}

/**
 * What the content page's "Up next" link points at: the next post waiting on
 * you, other than the one you're looking at. To review first (oldest first, as
 * fetched), then your turn oldest-touched first — the order fetched is newest
 * first, so it's reversed here. `remaining` counts everything else waiting.
 * `currentWaiting` says whether the post you're on is still waiting on you:
 * when it flips to false you just sent it on, which is the moment the page
 * offers the next one.
 *
 * `siblingsOf` = the post you're on: its siblings that are waiting on you
 * (the other cross-posts of the same post, the other clips of the same video)
 * jump the line, because a curator publishing five cross-posts went back to
 * the production list to find each next one. `sameSource` says the next one
 * is a sibling.
 */
export function upNext<R extends MyWorkRow & SourceLinks>(
  split: MyWorkSplit<R>,
  currentId: string | null,
  siblingsOf: SourceLinks | null = null,
): { next: R | null; remaining: number; currentWaiting: boolean; sameSource: boolean } {
  const all = [...split.toReview, ...[...split.yourTurn].reverse()];
  const queue = all.filter((r) => r.id !== currentId);
  const sibling = queue.find((r) => isSibling(r, siblingsOf)) ?? null;
  const next = sibling ?? queue[0] ?? null;
  return {
    next,
    remaining: queue.length,
    currentWaiting: currentId !== null && queue.length < all.length,
    sameSource: sibling !== null,
  };
}
