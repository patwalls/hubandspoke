/**
 * Weekly publish-count scorecard data.
 *
 * Drives the `/home` scorecard widget and the daily admin email. Uses a
 * rolling 7-day window (last 7 days vs. the 7 days before) rather than a
 * calendar week so that a daily email always shows an apples-to-apples
 * comparison instead of a Sunday-vs-Saturday distortion.
 *
 * Filter: `status = 'Published' AND published_date IS NOT NULL AND
 * published_date IN [start, end)`. We use `published_date` (DATE) rather
 * than `published_at` (TIMESTAMP) because the date is the canonical week
 * bucket the operator-facing dashboard already uses, and survives the
 * publishedAt-may-be-null reality after the 2026-04-25 sync writer fix.
 */

import { db } from "@/lib/db";
import { productionItems, brands, accounts } from "@/lib/db/schema";
import { and, eq, gte, lt, isNotNull, sql } from "drizzle-orm";

export interface BrandScorecard {
  slug: string;
  label: string;
  color: string | null;
  weeklyGoal: number | null;
  originals: number;
  reposts: number;
  crossPosts: number;
  clips: number;
  accountsShipped: number;
  totalAccounts: number;
}

export interface ScorecardWindow {
  /** Inclusive — the earliest publish date counted. */
  start: Date;
  /** Exclusive — `published_date < end`. */
  end: Date;
  /** Originals only — the headline. */
  totalOriginals: number;
  totalReposts: number;
  totalCrossPosts: number;
  totalClips: number;
  totalAccountsShipped: number;
  totalAccounts: number;
  byBrand: BrandScorecard[];
}

export interface ScorecardData {
  thisWeek: ScorecardWindow;
  lastWeek: ScorecardWindow;
}

/** Trim a Date down to UTC midnight on the same calendar day. */
function startOfUtcDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** YYYY-MM-DD — the format `published_date` is stored in. */
function toDateString(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** Aggregate published items in [start, end) for one brand-bucket query. */
async function loadWindow(
  start: Date,
  end: Date,
  brandRows: Array<{
    slug: string;
    label: string;
    color: string | null;
    weeklyGoal: number | null;
    activeAccountCount: number;
  }>
): Promise<ScorecardWindow> {
  const startStr = toDateString(start);
  const endStr = toDateString(end);

  const rows = await db
    .select({
      brand: productionItems.brand,
      sourceType: productionItems.sourceType,
      count: sql<number>`count(*)::int`,
      // distinct accounts that shipped in this window for this (brand, sourceType)
      // — we sum across sourceType after the fact for the per-brand denominator.
      distinctAccounts: sql<number>`count(distinct ${productionItems.accountId})::int`,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.publishedDate),
        gte(productionItems.publishedDate, startStr),
        lt(productionItems.publishedDate, endStr)
      )
    )
    .groupBy(productionItems.brand, productionItems.sourceType);

  // Separately compute accountsShipped per brand (distinct across all source
  // types, not summed) — a single account that posts an original AND a repost
  // in the same window should count once.
  const shippedRows = await db
    .select({
      brand: productionItems.brand,
      distinctAccounts: sql<number>`count(distinct ${productionItems.accountId})::int`,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.publishedDate),
        isNotNull(productionItems.accountId),
        gte(productionItems.publishedDate, startStr),
        lt(productionItems.publishedDate, endStr)
      )
    )
    .groupBy(productionItems.brand);

  const shippedByBrand = new Map<string, number>();
  for (const r of shippedRows) {
    shippedByBrand.set(r.brand, r.distinctAccounts);
  }

  const byBrand: BrandScorecard[] = brandRows.map((b) => ({
    slug: b.slug,
    label: b.label,
    color: b.color,
    weeklyGoal: b.weeklyGoal,
    originals: 0,
    reposts: 0,
    crossPosts: 0,
    clips: 0,
    accountsShipped: shippedByBrand.get(b.slug) ?? 0,
    totalAccounts: b.activeAccountCount,
  }));
  const brandIndex = new Map(byBrand.map((b, i) => [b.slug, i]));

  for (const row of rows) {
    const idx = brandIndex.get(row.brand);
    if (idx === undefined) continue; // brand not in our list (deleted/disabled)
    const target = byBrand[idx];
    switch (row.sourceType) {
      case "original":
        target.originals = row.count;
        break;
      case "repost":
        target.reposts = row.count;
        break;
      case "cross_post":
        target.crossPosts = row.count;
        break;
      case "clip":
        target.clips = row.count;
        break;
    }
  }

  const totals = byBrand.reduce(
    (acc, b) => {
      acc.totalOriginals += b.originals;
      acc.totalReposts += b.reposts;
      acc.totalCrossPosts += b.crossPosts;
      acc.totalClips += b.clips;
      acc.totalAccountsShipped += b.accountsShipped;
      acc.totalAccounts += b.totalAccounts;
      return acc;
    },
    {
      totalOriginals: 0,
      totalReposts: 0,
      totalCrossPosts: 0,
      totalClips: 0,
      totalAccountsShipped: 0,
      totalAccounts: 0,
    }
  );

  return { start, end, byBrand, ...totals };
}

export async function getScorecardData(now = new Date()): Promise<ScorecardData> {
  const today = startOfUtcDay(now);
  const thisWeekStart = addDays(today, -7);
  const lastWeekStart = addDays(today, -14);
  const thisWeekEnd = today;
  const lastWeekEnd = thisWeekStart;

  // Brands + active-account counts in one round trip.
  const brandRows = await db
    .select({
      slug: brands.slug,
      label: brands.label,
      color: brands.color,
      weeklyGoal: brands.weeklyGoal,
      activeAccountCount: sql<number>`count(${accounts.id}) filter (where ${accounts.isActive} = true)::int`,
    })
    .from(brands)
    .leftJoin(accounts, eq(accounts.brandId, brands.id))
    .where(eq(brands.disabled, false))
    .groupBy(brands.id)
    .orderBy(brands.label);

  const [thisWeek, lastWeek] = await Promise.all([
    loadWindow(thisWeekStart, thisWeekEnd, brandRows),
    loadWindow(lastWeekStart, lastWeekEnd, brandRows),
  ]);

  return { thisWeek, lastWeek };
}
