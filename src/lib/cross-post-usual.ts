// "Select usual" in the cross-post picker: the targets a source's format
// goes to in most of its recent cross-posts. Pure so the rule is unit-tested;
// the counts come from fetchTargetCommonalityByFormat (cross-post-candidates.ts).

export interface TargetCommonalityRow {
  accountId: string;
  postType: string;
  /** All-time cross-posts from this format to this pair (ranking). */
  count: number;
  /** Sources of this format cross-posted in the recent window that went to
   *  this pair. Absent on older payloads → never "usual". */
  recentSources?: number;
  /** Sources of this format cross-posted in the recent window, any target. */
  recentTotal?: number;
}

/** A format needs this many recently cross-posted sources before it has a
 *  "usual" — one or two is a coincidence, not a habit. */
export const USUAL_MIN_SOURCES = 3;
/** A pair is usual when at least this share of those sources went to it. */
export const USUAL_MIN_SHARE = 0.5;

/** Keys (`<accountId>:<postType>`) of the format's usual targets, limited to
 *  `selectableKeys` (targets that exist on the brand and aren't already
 *  cross-posted), in ranking order. Empty when the format has no habit yet. */
export function usualTargetKeys(
  ranking: TargetCommonalityRow[] | undefined,
  selectableKeys: Iterable<string>,
): string[] {
  if (!ranking?.length) return [];
  const selectable = new Set(selectableKeys);
  const out: string[] = [];
  for (const r of ranking) {
    const total = r.recentTotal ?? 0;
    const n = r.recentSources ?? 0;
    if (total < USUAL_MIN_SOURCES || n / total < USUAL_MIN_SHARE) continue;
    const key = `${r.accountId}:${r.postType}`;
    if (selectable.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}
