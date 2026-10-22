/**
 * What you can do to a My Work row without opening the item. Pure, so the
 * rules are tested.
 *
 * - **Your turn**, Assigned → "Send to review" (Review).
 * - **To review**, Review → "Approve" (Ready To Publish) or "Send back"
 *   (Assigned, with an optional note that lands as a comment).
 *
 * Statuses are per brand and some can be renamed, so an action only shows
 * when its target status exists on the item's brand. A brand with no
 * configured statuses (`brandStatuses` undefined) uses the defaults, which
 * have all three.
 */

export type RowActionKind = "send-to-review" | "approve" | "send-back";

export interface RowAction {
  kind: RowActionKind;
  label: string;
  /** Status the item moves to. */
  to: string;
  /** Single key that fires it on the focused row. */
  key: string;
}

const ACTIONS: Record<RowActionKind, RowAction> = {
  "send-to-review": { kind: "send-to-review", label: "Send to review", to: "Review", key: "r" },
  approve: { kind: "approve", label: "Approve", to: "Ready To Publish", key: "a" },
  "send-back": { kind: "send-back", label: "Send back", to: "Assigned", key: "b" },
};

export type MyWorkSection = "your-turn" | "to-review" | "waiting";

export function rowActionsFor(
  section: MyWorkSection,
  status: string | null,
  brandStatuses?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): RowAction[] {
  let kinds: RowActionKind[] = [];
  if (section === "your-turn" && status === "Assigned") kinds = ["send-to-review"];
  if (section === "to-review" && status === "Review") kinds = ["approve", "send-back"];
  return kinds
    .map((k) => ACTIONS[k])
    .filter((a) => !brandStatuses || brandStatuses.size === 0 || brandStatuses.has(a.to));
}

/** The note typed on "Send back" as safe comment HTML; null when blank. */
export function sendBackCommentHtml(note: string): string | null {
  const text = note.trim();
  if (!text) return null;
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<p>Sent back: ${escaped}</p>`;
}
