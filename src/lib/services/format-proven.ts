import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import {
  PROVEN_MIN_ITEMS,
  PROVEN_OUTLIER_MULTIPLIER,
  PROVEN_RECENT_WINDOW_DAYS,
  PROVEN_WINDOW_DAYS,
  type FormatProvenStatus,
  type ProvenReason,
  type ProvenSummary,
} from "./format-proven-shared";

// Re-export so existing server-side consumers (`@/lib/services/format-proven`)
// keep working — they imported types/constants from this file before the
// split. Don't import these from here in client components; use the
// `-shared` module directly.
export {
  PROVEN_MIN_ITEMS,
  PROVEN_OUTLIER_MULTIPLIER,
  PROVEN_RECENT_WINDOW_DAYS,
  PROVEN_WINDOW_DAYS,
};
export type { FormatProvenStatus, ProvenReason, ProvenSummary };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function dominantPostType(items: { postType: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it.postType) continue;
    counts.set(it.postType, (counts.get(it.postType) ?? 0) + 1);
  }
  let best: { key: string; count: number } | null = null;
  for (const [key, count] of counts) {
    if (!best || count > best.count) best = { key, count };
  }
  return best?.key ?? null;
}

interface ItemRow {
  format: string;
  postType: string | null;
  views: number;
  publishedDate: string;
}

/**
 * Compute proven status for every format that has any activity in the
 * 180-day window for the given brand. Single query + in-memory grouping.
 * Formats with zero published items in the window are NOT included in the
 * returned map — callers should treat absence as "stale / no signal."
 */
export async function computeProvenStatusForBrand(
  brand: string,
): Promise<Map<string, FormatProvenStatus>> {
  const windowStart = new Date(
    Date.now() - PROVEN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const rows = await db
    .select({
      format: productionItems.format,
      postType: productionItems.postType,
      views: productionItems.views,
      publishedDate: productionItems.publishedDate,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.format),
        isNotNull(productionItems.publishedDate),
        gte(productionItems.publishedDate, windowStart),
        isNull(productionItems.deletedAt),
      ),
    );

  const items: ItemRow[] = rows
    .filter(
      (r): r is { format: string; postType: string | null; views: number | null; publishedDate: string } =>
        r.format !== null && r.publishedDate !== null,
    )
    .map((r) => ({
      format: r.format,
      postType: r.postType,
      views: r.views ?? 0,
      publishedDate: r.publishedDate,
    }));

  return buildProvenStatusMap(items);
}

/**
 * Pure version of the algorithm — exported for tests and for callers that
 * already have the items in memory (e.g. the report aggregator).
 */
export function buildProvenStatusMap(
  items: ItemRow[],
): Map<string, FormatProvenStatus> {
  const recentCutoff = new Date(
    Date.now() - PROVEN_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const viewsByPostType = new Map<string, number[]>();
  const itemsByFormat = new Map<string, ItemRow[]>();
  for (const item of items) {
    if (item.postType) {
      const arr = viewsByPostType.get(item.postType) ?? [];
      arr.push(item.views);
      viewsByPostType.set(item.postType, arr);
    }
    const arr = itemsByFormat.get(item.format) ?? [];
    arr.push(item);
    itemsByFormat.set(item.format, arr);
  }

  const peerMedianByPostType = new Map<string, number>();
  for (const [postType, views] of viewsByPostType) {
    peerMedianByPostType.set(postType, median(views));
  }

  const out = new Map<string, FormatProvenStatus>();
  for (const [formatName, formatItems] of itemsByFormat) {
    const itemCount = formatItems.length;
    const recentItemCount = formatItems.filter(
      (i) => i.publishedDate >= recentCutoff,
    ).length;
    const postType = dominantPostType(formatItems);
    const peerMedian = postType ? peerMedianByPostType.get(postType) ?? 0 : 0;
    const formatMedian = median(formatItems.map((i) => i.views));
    const outlierThreshold = peerMedian * PROVEN_OUTLIER_MULTIPLIER;
    const hitCount = outlierThreshold > 0
      ? formatItems.filter((i) => i.views >= outlierThreshold).length
      : 0;

    let reason: ProvenReason;
    if (recentItemCount === 0) {
      reason = "stale";
    } else if (
      itemCount >= PROVEN_MIN_ITEMS &&
      formatMedian >= peerMedian &&
      peerMedian > 0 &&
      hitCount >= 1
    ) {
      reason = "proven";
    } else {
      reason = "testing";
    }

    out.set(formatName, {
      isProven: reason === "proven",
      reason,
      itemCount,
      recentItemCount,
      formatMedian,
      peerMedian,
      hitCount,
      dominantPostType: postType,
    });
  }

  return out;
}

export function summarizeProvenStatuses(
  statuses: Iterable<FormatProvenStatus>,
): ProvenSummary {
  let proven = 0;
  let testing = 0;
  let stale = 0;
  for (const s of statuses) {
    if (s.reason === "proven") proven += 1;
    else if (s.reason === "testing") testing += 1;
    else stale += 1;
  }
  return { proven, testing, stale };
}

/** Stable status for a format that has no recent activity at all. */
export function staleProvenStatus(): FormatProvenStatus {
  return {
    isProven: false,
    reason: "stale",
    itemCount: 0,
    recentItemCount: 0,
    formatMedian: 0,
    peerMedian: 0,
    hitCount: 0,
    dominantPostType: null,
  };
}

