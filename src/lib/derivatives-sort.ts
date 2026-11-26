/**
 * Sorting for the post page's Derivatives tab (everything made from one video:
 * its clips and designs, reposts, cross-posts). The tab's own order (pillar
 * tree first, then reposts, then cross-posts) stays the default; a click on
 * Published / Views / Likes / Comments re-orders by that column, biggest or
 * newest first, and a second click on the same column goes back to the
 * default. The choice is remembered per browser (`DERIVATIVES_SORT_KEY`).
 */

export type DerivativesSort = "default" | "published" | "views" | "likes" | "comments";

export const DERIVATIVES_SORTS: readonly DerivativesSort[] = [
  "default",
  "published",
  "views",
  "likes",
  "comments",
];

/** localStorage key for the remembered choice. */
export const DERIVATIVES_SORT_KEY = "derivatives:sort";

export interface SortableDerivativeRow {
  publishedDate: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

/** A stored value back to a sort, or "default" for anything unknown. */
export function parseDerivativesSort(raw: string | null | undefined): DerivativesSort {
  return (DERIVATIVES_SORTS as readonly string[]).includes(raw ?? "")
    ? (raw as DerivativesSort)
    : "default";
}

/** Clicking a header: that column, or back to the default when it's already on. */
export function toggleDerivativesSort(
  current: DerivativesSort,
  clicked: Exclude<DerivativesSort, "default">,
): DerivativesSort {
  return current === clicked ? "default" : clicked;
}

function keyOf(row: SortableDerivativeRow, sort: Exclude<DerivativesSort, "default">): number | null {
  if (sort === "published") {
    if (!row.publishedDate) return null;
    const t = Date.parse(row.publishedDate);
    return Number.isNaN(t) ? null : t;
  }
  return row[sort];
}

/**
 * Rows in the chosen order. Biggest / newest first; rows with no value (not
 * published yet, no numbers synced) go last in their original order, as do
 * ties. Never mutates `rows`.
 */
export function sortDerivativeRows<T extends SortableDerivativeRow>(
  rows: readonly T[],
  sort: DerivativesSort,
): T[] {
  if (sort === "default") return [...rows];
  return rows
    .map((row, i) => ({ row, i, k: keyOf(row, sort) }))
    .sort((a, b) => {
      if (a.k === null && b.k === null) return a.i - b.i;
      if (a.k === null) return 1;
      if (b.k === null) return -1;
      return b.k - a.k || a.i - b.i;
    })
    .map((x) => x.row);
}
