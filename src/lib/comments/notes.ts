/**
 * Open review notes (review-notes M2). Any comment can be marked done, but
 * only notes pinned to a moment of the video count as "open notes" in the
 * Activity header — counting every unresolved comment would light up every
 * old post with dozens of chat replies nobody will ever check off.
 */
export interface NoteLike {
  atSeconds: number | null | undefined;
  resolvedAt?: string | null;
}

export function isOpenNote(c: NoteLike): boolean {
  return c.atSeconds !== null && c.atSeconds !== undefined && !c.resolvedAt;
}

export function openNotesLabel(comments: NoteLike[]): string | null {
  const n = comments.filter(isOpenNote).length;
  if (n === 0) return null;
  return n === 1 ? "1 open note" : `${n} open notes`;
}
