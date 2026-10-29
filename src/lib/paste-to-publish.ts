// Paste-to-publish: on a content page that hasn't been published yet, a
// post link pasted anywhere outside a text field opens the Publish dialog
// with the link already filled in (one paste + Enter instead of button →
// field → paste → Enter). These helpers decide whether a page-level paste
// is ours; content-detail.tsx owns the listener.

/** Statuses where the header CTA is "Publish or Schedule" (pre-publish). */
export function acceptsPastedLink(status: string | null | undefined): boolean {
  return status !== "Published" && status !== "Scheduled";
}

/** The pasted text as a link, or null when it isn't exactly one http(s) URL. */
export function pastedPostLink(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t || /\s/.test(t)) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".")) return null;
  return t;
}

interface PasteTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** False when the paste lands in something that takes text itself (an
 *  input, a textarea, a rich-text editor) or inside an open dialog — those
 *  pastes belong to whatever the person is typing in. */
export function isPagePaste(target: PasteTargetLike | null | undefined): boolean {
  if (!target) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (target.isContentEditable) return false;
  if (target.closest?.('[role="dialog"], [role="alertdialog"], [contenteditable="true"]')) {
    return false;
  }
  return true;
}
