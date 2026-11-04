/**
 * The first words of My Work's next card (UpNext, content page): what just
 * happened to the post you're on. It used to say "Sent on." for every way a
 * post leaves your plate, so a kill or a plain status move read as if
 * someone had been handed the post.
 */
export function sentOnLine({
  status,
  prevStatus,
  editorChanged,
}: {
  status: string;
  /** Status at the previous read, while it was still waiting on you. */
  prevStatus: string | null;
  /** The editor changed since that read (you handed it to someone). */
  editorChanged: boolean;
}): string {
  if (status === "Published") return "Published.";
  if (status === "Killed") return "Killed.";
  if (status === prevStatus || !status) return editorChanged ? "Handed on." : "Off your plate.";
  if (status === "Review") return editorChanged ? "Handed on for review." : "Sent to review.";
  if (status === "Ready To Publish") return prevStatus === "Review" ? "Approved." : "Ready to publish.";
  return `Moved to ${status}.`;
}
