/**
 * The order a person publishes a post's cross-posts in (publish-one-trip M6).
 *
 * After publishing one cross-post, the Publish dialog's "Then open next" and
 * the post page's Up next both offer the next sibling waiting on you. They
 * used to offer them oldest-touched first, which for a batch created in one
 * second is arbitrary, so most landings ended in a trip back to the list to
 * pick a different platform. Publishers keep a habit of their own (one
 * always leaves Facebook and TikTok for last), so siblings are offered in
 * the order this person usually publishes them.
 *
 * `publishRanks` reads their recent Ready To Publish → Published moves:
 * within each post family (a post and its cross-posts), each publish gets
 * its place from 0 (first) to 1 (last), and a post type's rank is its
 * average place. Post types seen in fewer than MIN_FAMILIES families have
 * no rank and sit in the middle (0.5), so one odd day doesn't reorder them.
 */

export interface PublishedRow {
  /** The post family: the post it cross-posts, else the post itself. */
  family: string;
  postType: string | null;
  at: Date | string;
}

export const MIN_FAMILIES = 2;
const UNRANKED = 0.5;

export function publishRanks(rows: readonly PublishedRow[]): Map<string, number> {
  const families = new Map<string, PublishedRow[]>();
  for (const r of rows) {
    if (!r.postType) continue;
    const list = families.get(r.family) ?? [];
    list.push(r);
    families.set(r.family, list);
  }
  const places = new Map<string, number[]>();
  for (const list of families.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => +new Date(a.at) - +new Date(b.at));
    list.forEach((r, i) => {
      const seen = places.get(r.postType!) ?? [];
      seen.push(i / (list.length - 1));
      places.set(r.postType!, seen);
    });
  }
  const ranks = new Map<string, number>();
  for (const [type, seen] of places) {
    if (seen.length < MIN_FAMILIES) continue;
    ranks.set(type, seen.reduce((s, x) => s + x, 0) / seen.length);
  }
  return ranks;
}

/** Siblings in this person's publish order; ties (and no history) keep the order given. */
export function inPublishOrder<R extends object>(
  rows: readonly R[],
  ranks: ReadonlyMap<string, number> | null | undefined,
): R[] {
  if (!ranks || ranks.size === 0) return [...rows];
  const rank = (r: R) => {
    const type = (r as { postType?: string | null }).postType;
    return type ? ranks.get(type) ?? UNRANKED : UNRANKED;
  };
  return rows
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}
