/**
 * The one-click handoff on the content page. Pure, so the rules are tested.
 *
 * The team passes work along by setting the item's editor to the next person
 * AND moving its status, two clicks every time (~200 a month):
 * - the editor finishes → editor = the brand's reviewer, status Review;
 * - the reviewer approves → editor = whoever sent it to review, status Ready
 *   To Publish.
 * Nobody is assigned as a reviewer in the data, so the history is the
 * assignment: a brand's reviewer is whoever moved its posts out of Review most
 * in the last 30 days (same rule as My Work's To review).
 */

export interface HandoffPerson {
  id: string;
  name: string;
}

export interface Handoff {
  kind: "send-to-review" | "approve";
  /** Status the item moves to. */
  to: string;
  /** Who it's handed to (the new editor). */
  person: HandoffPerson;
  /** Other people it could go to (send-to-review only), best first. */
  others: HandoffPerson[];
}

export const REVIEW = "Review";
export const ASSIGNED = "Assigned";
export const READY = "Ready To Publish";

export function pickHandoff(input: {
  me: string;
  status: string | null;
  editorUserId: string | null;
  /** Statuses that exist on the item's brand; empty = the defaults (all three). */
  brandStatuses: ReadonlySet<string>;
  /** The brand's reviewers, most approvals first. */
  reviewers: HandoffPerson[];
  /** Who last moved this item into Review. */
  sentToReviewBy: HandoffPerson | null;
}): Handoff | null {
  const { me, status, editorUserId, brandStatuses, reviewers, sentToReviewBy } = input;
  const has = (s: string) => brandStatuses.size === 0 || brandStatuses.has(s);

  // Only the editor sends their own work to review.
  if (status === ASSIGNED && has(REVIEW) && editorUserId === me) {
    const candidates = reviewers.filter((r) => r.id !== me);
    if (candidates.length === 0) return null;
    const [person, ...others] = candidates;
    return { kind: "send-to-review", to: REVIEW, person, others };
  }

  if (status === REVIEW && has(READY) && sentToReviewBy) {
    // Sent by the person who'd approve it (or still with them): plain status
    // change, nothing to hand back.
    if (sentToReviewBy.id === me || sentToReviewBy.id === editorUserId) return null;
    return { kind: "approve", to: READY, person: sentToReviewBy, others: [] };
  }

  return null;
}

/** First name for the button label ("Andrew Gibbs" → "Andrew"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
