/**
 * What changed on a My Work row since you last touched it (my-day M3).
 * Pure, so the rules are tested; the reads live in `getRowNews`
 * (`queries.ts`).
 *
 * - The row shows the latest comment someone else left (last 30 days),
 *   as a one-line preview with their first name.
 * - It is **new** (a dot) when that comment, or a send-back, came after
 *   your own last action on the item (an edit, status change or comment).
 *   An item you never touched counts everything as new.
 * - **Sent back** = someone else moved it from Review (or Ready To
 *   Publish) back to Assigned after your last action. An old send-back
 *   you already acted on doesn't show.
 */

export interface RowNewsInput {
  /** Latest comment on the item by someone other than you. */
  lastComment?: { author: string; text: string; at: Date } | null;
  /** Latest move back to Assigned by someone other than you. */
  lastSendBack?: { by: string; at: Date } | null;
  /** Your own last action on the item (event or comment). */
  myLastAt?: Date | null;
}

export interface RowNews {
  comment: { author: string; text: string; at: Date } | null;
  sentBack: { by: string; at: Date } | null;
  isNew: boolean;
}

const PREVIEW_CHARS = 140;

export function rowNews({ lastComment, lastSendBack, myLastAt }: RowNewsInput): RowNews | null {
  const after = (at: Date) => !myLastAt || at.getTime() > myLastAt.getTime();
  const sentBack = lastSendBack && after(lastSendBack.at) ? lastSendBack : null;
  const comment = lastComment && lastComment.text.trim()
    ? { ...lastComment, text: previewText(lastComment.text) }
    : null;
  if (!comment && !sentBack) return null;
  return {
    comment,
    sentBack,
    isNew: !!sentBack || (!!comment && after(comment.at)),
  };
}

/** One line of plain comment text: whitespace collapsed, entities decoded, capped. */
export function previewText(plain: string): string {
  const text = plain
    .replace(/\s+/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : text;
}

/** "5m", "3h", "2d" — how long ago, for the row. */
export function ago(at: Date, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
