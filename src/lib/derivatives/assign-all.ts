/**
 * "Assign all" on a video's Derivatives tab: when a format spawns a batch of
 * posts, they all start at Idea and the curator used to open each one to set
 * its editor and move it to Assigned. This picks which rows the one-click
 * version touches. Pure, so the rule is tested.
 *
 * - Only rows still at Idea. Anything further along already has its owner.
 * - Rows that already have an editor are included: new posts used to start
 *   with a default owner, and the curator reassigned those too.
 * - Hidden for fewer than two rows (one row is a single click already) and
 *   when the brand has no "Assigned" status to move them to.
 */

export const ASSIGN_ALL_FROM = "Idea";
export const ASSIGN_ALL_TO = "Assigned";

export function assignAllIds(
  rows: readonly { id: string; status: string | null }[],
  brandStatuses: ReadonlySet<string>,
): string[] {
  if (!brandStatuses.has(ASSIGN_ALL_TO)) return [];
  const ids = [
    ...new Set(rows.filter((r) => r.status === ASSIGN_ALL_FROM).map((r) => r.id)),
  ];
  return ids.length >= 2 ? ids : [];
}
