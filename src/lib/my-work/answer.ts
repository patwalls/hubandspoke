/**
 * Answering a post in Review straight from the morning email (idea c3c5fb).
 * Pure, so the rules are tested; the page is /my-work/answer/[id].
 *
 * MaTG and My First Million posts waited 2-9 days in Review: their reviewers
 * clear posts in one sitting a week and quietly skip the ones they don't want,
 * and some posts they had already posted outside the app sat in Review anyway.
 * Ignoring a post cost nothing; saying no or "it's up" took a login and a
 * hunt. So each To review line in the email carries the three answers, each as
 * cheap as the other two:
 *
 * - **Approve** → Ready To Publish, handed back to whoever sent it to review
 *   (same rule as My Work's Approve).
 * - **Already posted** → Published with the link they paste, through the
 *   publish route (the one door to Published: it requires the link).
 * - **Not this one** → Killed, with their reason (the kill rule: 10+
 *   characters; it shows in the post's Activity for the editor).
 *
 * The email link only opens the page with that answer picked; nothing moves
 * until the tap on the page. Mail scanners open every link in an email, so a
 * link that acted on GET would approve posts nobody read.
 */

import type { HandoffPerson } from "@/lib/handoff/pick";

export type AnswerKind = "approve" | "posted" | "pass";

export interface Answer {
  kind: AnswerKind;
  label: string;
  /** Status the post moves to. */
  to: string;
}

export const ANSWERS: Answer[] = [
  { kind: "approve", label: "Approve", to: "Ready To Publish" },
  { kind: "posted", label: "Already posted", to: "Published" },
  { kind: "pass", label: "Not this one", to: "Killed" },
];

export function parseAnswer(raw: string | null | undefined): AnswerKind | null {
  return ANSWERS.find((a) => a.kind === raw)?.kind ?? null;
}

/**
 * The answers a post can take: only from Review, and only those whose
 * status exists on the brand (empty set = the default statuses, all three).
 */
export function answersFor(status: string | null, brandStatuses: ReadonlySet<string>): Answer[] {
  if (status !== "Review") return [];
  return ANSWERS.filter((a) => brandStatuses.size === 0 || brandStatuses.has(a.to));
}

export interface AnswerRequest {
  url: string;
  method: "PUT" | "POST";
  body: Record<string, string>;
}

/** The PUT route refuses a kill without a reason this long. */
export const KILL_REASON_MIN = 10;

/**
 * The request that saves an answer: the generic PUT for Approve / Not this
 * one, POST .../publish for Already posted. Null until the answer has what
 * its route requires: a link for Already posted, a reason for Not this one.
 */
export function answerRequest(
  kind: AnswerKind,
  input: {
    id: string;
    me: string;
    /** Who last moved the post into Review. */
    sentToReviewBy: HandoffPerson | null;
    /** The pasted link (Already posted). */
    link?: string;
    /** Why not (Not this one). */
    reason?: string;
    /** YYYY-MM-DD, the reviewer's today. */
    today: string;
  },
): AnswerRequest | null {
  if (kind === "posted") {
    const link = input.link?.trim();
    if (!link) return null;
    return {
      url: `/api/production-items/${input.id}/publish`,
      method: "POST",
      body: { mode: "publish", link, publishedDate: input.today },
    };
  }
  if (kind === "pass") {
    const reason = input.reason?.trim() ?? "";
    if (reason.length < KILL_REASON_MIN) return null;
    return { url: "/api/production-items", method: "PUT", body: { id: input.id, status: "Killed", killReason: reason } };
  }
  const to = ANSWERS.find((a) => a.kind === kind)!.to;
  const body: Record<string, string> = { id: input.id, status: to };
  const sender = input.sentToReviewBy;
  if (kind === "approve" && sender && sender.id !== input.me) body.editorUserId = sender.id;
  return { url: "/api/production-items", method: "PUT", body };
}

/** Whole days a post has waited ("9 days"); null under a day. */
export function waited(since: Date, now: Date = new Date()): string | null {
  const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
  if (days < 1) return null;
  return days === 1 ? "1 day" : `${days} days`;
}
