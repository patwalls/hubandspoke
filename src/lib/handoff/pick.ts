/**
 * The one-click handoff on the content page. Pure, so the rules are tested.
 *
 * The team passes work along by setting the item's editor to the next person
 * AND moving its status, two clicks every time (~200 a month):
 * - the editor finishes → editor = the brand's reviewer, status Review;
 * - the reviewer approves → editor = whoever sent it to review, status Ready
 *   To Publish (if they're already the editor, only the status moves);
 * - the editor moved it to Review from the status menu and still holds it →
 *   name the reviewer: editor = the brand's reviewer, status stays Review.
 *   (A post handed to a named reviewer left Review in ~2 h at the median vs
 *   ~1 day for one left with its editor, 21 days to 2026-11-03.)
 * Nobody is assigned as a reviewer in the data, so the history is the
 * assignment: a brand's reviewer is whoever moved its posts out of Review most
 * in the last 30 days (same rule as My Work's To review).
 */

export interface HandoffPerson {
  id: string;
  name: string;
}

export interface Handoff {
  kind: "send-to-review" | "name-reviewer" | "approve" | "assign";
  /** Status the item moves to. */
  to: string;
  /** Who it's handed to (the new editor). */
  person: HandoffPerson;
  /** Other people it could go to (send-to-review / name-reviewer / assign), best first. */
  others: HandoffPerson[];
}

export const REVIEW = "Review";
export const ASSIGNED = "Assigned";
export const READY = "Ready To Publish";
export const IDEA = "Idea";

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
  /** Who hands this brand + format's posts in (Assigned → Review), most first. */
  formatEditors?: HandoffPerson[];
}): Handoff | null {
  const { me, status, editorUserId, brandStatuses, reviewers, sentToReviewBy } = input;
  const formatEditors = input.formatEditors ?? [];
  const has = (s: string) => brandStatuses.size === 0 || brandStatuses.has(s);

  // Only the editor sends their own work to review.
  if (status === ASSIGNED && has(REVIEW) && editorUserId === me) {
    const candidates = reviewers.filter((r) => r.id !== me);
    if (candidates.length === 0) return null;
    const [person, ...others] = candidates;
    return { kind: "send-to-review", to: REVIEW, person, others };
  }

  // In Review, still mine, and I'm the one who sent it (or nobody did): the
  // reviewer was never named (moved from the status menu). Same people as
  // send-to-review; only the editor moves.
  if (status === REVIEW && editorUserId === me && (!sentToReviewBy || sentToReviewBy.id === me)) {
    const candidates = reviewers.filter((r) => r.id !== me);
    if (candidates.length === 0) return null;
    const [person, ...others] = candidates;
    return { kind: "name-reviewer", to: REVIEW, person, others };
  }

  if (status === REVIEW && has(READY) && sentToReviewBy) {
    // My own post: nothing for me to approve.
    if (sentToReviewBy.id === me) return null;
    // Still offered when the sender already holds it: the daily reviewer
    // sets the editor back first, and the approve click must survive that
    // (it then only moves the status; the button says so).
    return { kind: "approve", to: READY, person: sentToReviewBy, others: [] };
  }

  // Not started yet (an Idea, or a clip built and parked in Ready To
  // Publish) and nobody else holds it: give it to the person who makes this
  // format, brief included. The curator did this in three steps (status,
  // editor, comment) about once a day, almost always to the same editor.
  if (
    (status === IDEA || status === READY) &&
    has(ASSIGNED) &&
    (!editorUserId || editorUserId === me)
  ) {
    const candidates = formatEditors.filter((p) => p.id !== me);
    if (candidates.length === 0) return null;
    const [person, ...others] = candidates;
    return { kind: "assign", to: ASSIGNED, person, others };
  }

  return null;
}

/** First name for the button label ("Andrew Gibbs" → "Andrew"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * The comment box's "Comment & send to review → Andrew" (editor-handoffs M1).
 * Outside editors never used the status-chip button: every one of their moves
 * to Review came with a comment within 10 minutes (a "review & publish" note,
 * a design link), because their handoff IS a note. So the comment box offers
 * the same handoff, and the note rides it. Only the editor-side handoffs; the
 * reviewer's approve stays on the chip.
 */
export function composerHandoffLabel(handoff: Handoff | null): string | null {
  if (!handoff) return null;
  const who = firstName(handoff.person.name);
  if (handoff.kind === "send-to-review") return `Comment & send to review → ${who}`;
  if (handoff.kind === "name-reviewer") return `Comment & hand to ${who}`;
  if (handoff.kind === "assign") return `Comment & assign → ${who}`;
  return null;
}

/**
 * A comment posted with a handoff (`handoffTo`) lands right after the
 * handoff's own "assigned" email to that person, so their copy of the comment
 * is bell-only. Only honoured when they really are the post's editor now (the
 * handoff saved first), so a stray `handoffTo` can't mute anyone else.
 */
export function isHandoffNoteRecipient(
  handoffTo: string | null,
  editorUserId: string | null,
  recipientId: string,
): boolean {
  return !!handoffTo && handoffTo === editorUserId && recipientId === handoffTo;
}

/**
 * Who My Work's next card (UpNext) offers to hand the post to, the moment it
 * leaves your plate (editor-handoffs M3). Only after a move to Review from the
 * status menu that left you holding it (`name-reviewer`): a designer moved 7
 * posts to Review in a minute that way, clicking the card's "Open next" each
 * time, and never the "Hand to …" button beside the status — the card is where
 * their eyes are. Never a send-to-review or an approve: by the time the card
 * is up the status has already moved.
 */
export function nextCardHandoff(handoff: Handoff | null): HandoffPerson | null {
  return handoff?.kind === "name-reviewer" ? handoff.person : null;
}
