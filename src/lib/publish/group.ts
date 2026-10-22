/**
 * Publish screen grouping: one pillar's cross-posts sit together so the
 * curator posts a pillar out to every platform in one go. Items with no
 * pillar collect in a trailing "Other posts" group. Groups keep the order of
 * their oldest-waiting item (the input is already oldest-first).
 */
export interface PillarGroup<T> {
  key: string;
  pillarId: string | null;
  title: string;
  items: T[];
}

export function groupByPillar<
  T extends { pillarId: string | null; pillarTitle: string | null },
>(items: T[]): PillarGroup<T>[] {
  const groups = new Map<string, PillarGroup<T>>();
  const loose: T[] = [];
  for (const item of items) {
    if (!item.pillarId) {
      loose.push(item);
      continue;
    }
    let g = groups.get(item.pillarId);
    if (!g) {
      g = {
        key: item.pillarId,
        pillarId: item.pillarId,
        title: item.pillarTitle?.trim() || "Untitled pillar",
        items: [],
      };
      groups.set(item.pillarId, g);
    }
    g.items.push(item);
  }
  const out = [...groups.values()];
  if (loose.length > 0) {
    out.push({ key: "other", pillarId: null, title: "Other posts", items: loose });
  }
  return out;
}

/**
 * Arriving from a content page (`/[brand]/publish?focus=<itemId>`): the group
 * holding that post moves to the top, so the video someone just cross-posted
 * is the first thing on the screen. Unknown or missing id → order unchanged.
 */
export function focusGroupFirst<T extends { id: string }>(
  groups: PillarGroup<T>[],
  focusId: string | null | undefined,
): PillarGroup<T>[] {
  if (!focusId) return groups;
  const at = groups.findIndex((g) => g.items.some((i) => i.id === focusId));
  if (at <= 0) return groups;
  return [groups[at], ...groups.slice(0, at), ...groups.slice(at + 1)];
}
