import { postTypeLabel } from "@/lib/badge-colors";

/**
 * The question to ask before a status change takes a post that is live off
 * Published, or null when the change needs no confirm.
 *
 * Cross-posts share their source's title, so a same-titled click can land on
 * the live sibling and move it back to Review without anyone noticing. Only
 * the move away from Published asks; every other status change (and Kill,
 * which has its own dialog) stays one click.
 */
export function leavePublishedConfirm(
  prevStatus: string | null | undefined,
  nextStatus: string | null | undefined,
  postType: string | null | undefined,
): string | null {
  if (prevStatus !== "Published") return null;
  if (!nextStatus || nextStatus === "Published" || nextStatus === "Killed") {
    return null;
  }
  const label = postTypeLabel(postType);
  const what = label === "—" ? "This post" : `This ${label} post`;
  return `${what} is already Published. Move it back to ${nextStatus}?`;
}
