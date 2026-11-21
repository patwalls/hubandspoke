import type { ContentDraftContent, FormatFieldSchema } from "@/lib/db/schema";

/**
 * What the In Production row peek (M4) shows of a post's draft: its written
 * fields in the format's order (caption, description, tweet text, slides),
 * each cut to a readable length, so a reviewer can tell what the post is
 * without opening it.
 */
export const PEEK_MAX_FIELDS = 3;
export const PEEK_MAX_CHARS = 600;

export interface PeekField {
  label: string;
  text: string;
}

function fieldText(v: ContentDraftContent[string]): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (!Array.isArray(v)) return "";
  const parts = v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String(x.text ?? "") : ""));
  // Tags read as a list; slides as paragraphs.
  const isSlides = v.some((x) => x && typeof x === "object");
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(isSlides ? "\n\n" : ", ");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function draftPreview(
  content: ContentDraftContent | null | undefined,
  schema: FormatFieldSchema | null | undefined,
  { maxFields = PEEK_MAX_FIELDS, maxChars = PEEK_MAX_CHARS } = {},
): PeekField[] {
  if (!content) return [];
  const labelled = schema?.fields?.length
    ? schema.fields.map((f) => ({ key: f.key, label: f.label }))
    : [];
  // Keys the snapshot doesn't name (older drafts, renamed fields) still show,
  // after the named ones, labelled by their key.
  const named = new Set(labelled.map((f) => f.key));
  const extra = Object.keys(content)
    .filter((k) => !named.has(k))
    .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ") }));
  const out: PeekField[] = [];
  for (const f of [...labelled, ...extra]) {
    const text = fieldText(content[f.key]);
    if (!text) continue;
    out.push({ label: f.label, text: clip(text, maxChars) });
    if (out.length >= maxFields) break;
  }
  return out;
}

/**
 * The peek's "paste the live link" box (review-doesnt-wait M1): shown only on
 * posts someone is about to put live — Review and Ready To Publish. On the
 * busiest brand the reviewer takes a post out of Review by posting it and
 * pasting its link (every Review→Published move in 30 d set the link), so the
 * peek can do that without opening the post. Never on Assigned (still being
 * edited), Scheduled (has its date) or Published (already has a link).
 */
export const PEEK_PUBLISH_STATUSES: ReadonlySet<string> = new Set(["Review", "Ready To Publish"]);

export function peekCanPublish(status: string | null | undefined, canEdit: boolean): boolean {
  return canEdit && !!status && PEEK_PUBLISH_STATUSES.has(status);
}

/** The row after `id` in on-screen order (else the one before), so publishing
 *  from the peek steps it to the next post instead of closing it. */
export function nextAfter(order: readonly string[], id: string): string | null {
  const at = order.indexOf(id);
  if (at < 0) return null;
  return order[at + 1] ?? order[at - 1] ?? null;
}

/** The peek's Approve button (review-doesnt-wait M2): a Review post moves to
 *  Ready To Publish without opening it — for brands whose reviewer approves
 *  and someone else posts (14 d: Review→RTP 11×, three people). */
export function peekCanApprove(status: string | null | undefined, canEdit: boolean): boolean {
  return canEdit && status === "Review";
}

/** How long a Review post sits untouched before the peek asks "still needed?". */
export const STALE_REVIEW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A Review post nobody is working on (review-doesnt-wait M3): in Review
 * 14 d+ AND no comment in 14 d. Every post stuck in Review on 2026-11-21 had
 * comments, so "no comments at all" would match none — it's the last one that
 * says whether anyone still cares. The peek then offers On Hold / Kill.
 * No `statusSince` (moved before events were recorded) → not stale: we can't
 * tell how long it's been.
 */
export function peekStaleReview(
  status: string | null | undefined,
  statusSinceAt: string | null | undefined,
  lastCommentAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (status !== "Review" || !statusSinceAt) return false;
  const limit = STALE_REVIEW_DAYS * DAY_MS;
  const since = Date.parse(statusSinceAt);
  if (!Number.isFinite(since) || now - since < limit) return false;
  if (!lastCommentAt) return true;
  const last = Date.parse(lastCommentAt);
  return !Number.isFinite(last) || now - last >= limit;
}
