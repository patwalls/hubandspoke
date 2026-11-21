/**
 * The In Production "Editor" pill: how many rows each person holds, and the
 * usage mark for picking one. Kept pure so the label rule is tested without
 * rendering the list.
 *
 * Editors open In Production many times a day to check whether anything is
 * waiting on them; the count on "Just me" answers that without filtering.
 */

/** Rows per editor across the list (other pills don't change the counts, so
 *  the numbers stay put while someone narrows by channel or format). */
export function rowsPerEditor(
  items: ReadonlyArray<{ editorUserId?: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.editorUserId) continue;
    counts.set(item.editorUserId, (counts.get(item.editorUserId) ?? 0) + 1);
  }
  return counts;
}

/** "Just me · 3" / "Lauren · 2"; a zero count shows the bare name. */
export function withCount(label: string, count: number | undefined): string {
  return count && count > 0 ? `${label} · ${count}` : label;
}

/** `production:editor-filter:<me|other|all>` for a pick, null when unchanged. */
export function editorFilterMark(
  next: string,
  prev: string,
  currentUserId: string | null,
): string | null {
  if (next === prev) return null;
  const which =
    next === "all" ? "all" : currentUserId && next === currentUserId ? "me" : "other";
  return `production:editor-filter:${which}`;
}
