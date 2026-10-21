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
