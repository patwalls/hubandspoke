import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts as accountsTable, productionItems as productionItemsTable } from "@/lib/db/schema";

// Per-(format, post_type) view bars over a rolling window. Two flavors:
//
//   1. Lifetime bars — `fetchFormatViewBars` — percentile of cumulative
//      `production_items.views` for posts in a (format, post_type). Drives
//      the Content tab's "vs P75" badge and the cross-post queue's
//      lifetime gate.
//
//   2. Velocity bars — `fetchFormatCheckpointBars` — percentile of
//      `view_snapshots.views` at each capture-velocity-snapshot
//      checkpoint (15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h). Drives the
//      cross-post queue's age-fair gate so a 6-hour-old rocket isn't
//      penalized against a cohort that's had days to mature.
//
// Scoped by (format, post_type) so a format that lives on multiple post
// types (e.g. "Laptop POV" appearing on X tweets *and* YT community
// posts, where view counts differ by an order of magnitude) doesn't pool
// apples and oranges into a single distribution. Cross-brand within that
// scope by design — same (format, post_type) on different brands shares
// one bar.

export const FORMAT_BARS_DEFAULT_WINDOW_DAYS = 90;
export const FORMAT_BARS_DEFAULT_PERCENTILE = 0.75;
export const FORMAT_BARS_DEFAULT_MIN_COHORT = 10;

export interface FormatBar {
  p: number;
  /** Which percentile this is (e.g. 0.75 for P75). Echoed back so callers
   *  can render the right label without remembering what they asked for. */
  percentile: number;
  cohortSize: number;
}

/** Outer key: format name. Inner key: post_type. A format that appears on
 *  multiple post types has one bar per post type. */
export type FormatBars = Record<string, Record<string, FormatBar>>;

export interface FetchFormatViewBarsOptions {
  /** Default 0.75 (P75). The cross-post queue uses 0.60 to compensate for
   *  age bias — a 6-hour-old post hasn't had the same time to accumulate
   *  views as a 60-day-old cohort member. */
  percentile?: number;
  /** Default 90 days. */
  windowDays?: number;
  /** Default 10. Set to 0 to admit every format that has ≥1 cohort post.
   *  The cross-post queue uses 0 so brand-new formats can surface even
   *  before they have a stable distribution. */
  minCohort?: number;
}

export async function fetchFormatViewBars(
  opts: FetchFormatViewBarsOptions = {}
): Promise<FormatBars> {
  const percentile = opts.percentile ?? FORMAT_BARS_DEFAULT_PERCENTILE;
  const windowDays = opts.windowDays ?? FORMAT_BARS_DEFAULT_WINDOW_DAYS;
  const minCohort = opts.minCohort ?? FORMAT_BARS_DEFAULT_MIN_COHORT;

  const rows = await db.execute<{
    format: string;
    post_type: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      format,
      post_type,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY views) AS p,
      count(*) AS cohort_size
    FROM production_items
    WHERE format IS NOT NULL
      AND post_type IS NOT NULL
      AND status = 'Published'
      AND deleted_at IS NULL
      AND views IS NOT NULL
      AND published_at >= (now() - interval '${sql.raw(String(windowDays))} days')
    GROUP BY format, post_type
    HAVING count(*) >= ${minCohort}
  `);

  const bars: FormatBars = {};
  for (const row of rows) {
    if (!bars[row.format]) bars[row.format] = {};
    bars[row.format][row.post_type] = {
      p: Number(row.p),
      percentile,
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}

export interface CheckpointBar {
  p: number;
  percentile: number;
  cohortSize: number;
}

/** Map<format, Map<post_type, Map<checkpoint_key, bar>>>. Checkpoint keys
 *  come from VELOCITY_CHECKPOINTS in src/lib/velocity-checkpoints.ts.
 *  Scoped by (format, post_type) for the same reason as FormatBars. */
export type FormatCheckpointBars = Record<
  string,
  Record<string, Record<string, CheckpointBar>>
>;

export interface FetchFormatCheckpointBarsOptions {
  percentile?: number;
  windowDays?: number;
  /** Per-(format, checkpoint) cohort floor. Default 5 — velocity samples
   *  are sparser than lifetime data because each post only contributes
   *  one row per checkpoint. */
  minCohort?: number;
}

/** Map<post_type, bar>. Used as the fallback cohort when a candidate's
 *  format has no rows of its own — comparing against every other post of
 *  the same post type (e.g. "all instagram_reels") is still better than
 *  surfacing with no comparison at all. */
export type PostTypeBars = Record<string, FormatBar>;

/** Outer key: account UUID. Inner: format. Innermost: post_type.
 *  The repost v2 algorithm compares a candidate against its own
 *  (account, format, post_type) cohort first. Empty inner objects when
 *  the account doesn't have enough items in that format to form a
 *  cohort. */
export type AccountFormatBars = Record<
  string,
  Record<string, Record<string, FormatBar>>
>;

export interface FetchAccountFormatViewBarsOptions
  extends FetchFormatViewBarsOptions {
  /** Limit the query to these account ids. Required — without it the
   *  cross-account scan would return tens of thousands of (account,
   *  format, post_type) tuples. */
  accountIds: string[];
}

/**
 * Per-account percentile of `views` grouped by (account_id, format,
 * post_type). Uses an all-time window by default — repost v2 wants to
 * say "this post outperformed every other post of the same format on
 * this exact channel," and the longer the history, the more meaningful
 * "P75" is for cohorts that only see a few posts per format per quarter.
 *
 * `windowDays = null` means no time filter (all-time).
 */
export async function fetchAccountFormatViewBars(
  opts: FetchAccountFormatViewBarsOptions
): Promise<AccountFormatBars> {
  const percentile = opts.percentile ?? FORMAT_BARS_DEFAULT_PERCENTILE;
  const windowDays = opts.windowDays ?? null;
  const minCohort = opts.minCohort ?? 5;

  if (opts.accountIds.length === 0) return {};

  // Optional time filter — null means all-time.
  const windowFilter =
    windowDays != null
      ? sql`AND published_at >= (now() - interval '${sql.raw(String(windowDays))} days')`
      : sql``;

  const rows = await db.execute<{
    account_id: string;
    format: string;
    post_type: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      account_id,
      format,
      post_type,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY views) AS p,
      count(*) AS cohort_size
    FROM production_items
    WHERE ${inArray(productionItemsTable.accountId, opts.accountIds)}
      AND format IS NOT NULL
      AND post_type IS NOT NULL
      AND status = 'Published'
      AND deleted_at IS NULL
      AND views IS NOT NULL
      ${windowFilter}
    GROUP BY account_id, format, post_type
    HAVING count(*) >= ${minCohort}
  `);

  const bars: AccountFormatBars = {};
  for (const row of rows) {
    if (!bars[row.account_id]) bars[row.account_id] = {};
    if (!bars[row.account_id][row.format]) bars[row.account_id][row.format] = {};
    bars[row.account_id][row.format][row.post_type] = {
      p: Number(row.p),
      percentile,
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}

/** Map<brand_id, Map<format, Map<post_type, bar>>>. Same shape as
 *  AccountFormatBars but grouped by brand. Repost v2's first fallback
 *  when an account has fewer than 5 items in a given format. */
export type BrandFormatBars = Record<
  string,
  Record<string, Record<string, FormatBar>>
>;

export interface FetchBrandFormatViewBarsOptions
  extends FetchFormatViewBarsOptions {
  brandIds: string[];
}

export async function fetchBrandFormatViewBars(
  opts: FetchBrandFormatViewBarsOptions
): Promise<BrandFormatBars> {
  const percentile = opts.percentile ?? FORMAT_BARS_DEFAULT_PERCENTILE;
  const windowDays = opts.windowDays ?? null;
  const minCohort = opts.minCohort ?? 5;

  if (opts.brandIds.length === 0) return {};

  // Drop table aliases here. `inArray(accountsTable.brandId, …)` emits
  // a fully-qualified `"accounts"."brand_id"` reference; if the FROM
  // clause aliases `accounts` as `a`, Postgres can't resolve the bare
  // `accounts` qualifier and errors with "missing FROM-clause entry
  // for table 'accounts'". Selecting via the unaliased table names
  // keeps inArray's emitted SQL valid. (Same reason fetchAccountFormat-
  // ViewBars below doesn't alias `production_items`.)
  const windowFilter =
    windowDays != null
      ? sql`AND production_items.published_at >= (now() - interval '${sql.raw(String(windowDays))} days')`
      : sql``;

  const rows = await db.execute<{
    brand_id: string;
    format: string;
    post_type: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      accounts.brand_id AS brand_id,
      production_items.format,
      production_items.post_type,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY production_items.views) AS p,
      count(*) AS cohort_size
    FROM production_items
    JOIN accounts ON accounts.id = production_items.account_id
    WHERE ${inArray(accountsTable.brandId, opts.brandIds)}
      AND production_items.format IS NOT NULL
      AND production_items.post_type IS NOT NULL
      AND production_items.status = 'Published'
      AND production_items.deleted_at IS NULL
      AND production_items.views IS NOT NULL
      ${windowFilter}
    GROUP BY accounts.brand_id, production_items.format, production_items.post_type
    HAVING count(*) >= ${minCohort}
  `);

  const bars: BrandFormatBars = {};
  for (const row of rows) {
    if (!bars[row.brand_id]) bars[row.brand_id] = {};
    if (!bars[row.brand_id][row.format]) bars[row.brand_id][row.format] = {};
    bars[row.brand_id][row.format][row.post_type] = {
      p: Number(row.p),
      percentile,
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}

export async function fetchPostTypeViewBars(
  opts: FetchFormatViewBarsOptions = {}
): Promise<PostTypeBars> {
  const percentile = opts.percentile ?? FORMAT_BARS_DEFAULT_PERCENTILE;
  const windowDays = opts.windowDays ?? FORMAT_BARS_DEFAULT_WINDOW_DAYS;
  const minCohort = opts.minCohort ?? 0;

  const rows = await db.execute<{
    post_type: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      post_type,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY views) AS p,
      count(*) AS cohort_size
    FROM production_items
    WHERE post_type IS NOT NULL
      AND status = 'Published'
      AND deleted_at IS NULL
      AND views IS NOT NULL
      AND published_at >= (now() - interval '${sql.raw(String(windowDays))} days')
    GROUP BY post_type
    HAVING count(*) >= ${minCohort}
  `);

  const bars: PostTypeBars = {};
  for (const row of rows) {
    bars[row.post_type] = {
      p: Number(row.p),
      percentile,
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}

/** Map<post_type, Map<checkpoint_key, bar>>. Velocity flavor of the post-
 *  type fallback cohort — used when a format has no per-checkpoint cohort
 *  but the post type does. */
export type PostTypeCheckpointBars = Record<
  string,
  Record<string, CheckpointBar>
>;

export async function fetchPostTypeCheckpointBars(
  opts: FetchFormatCheckpointBarsOptions = {}
): Promise<PostTypeCheckpointBars> {
  const percentile = opts.percentile ?? FORMAT_BARS_DEFAULT_PERCENTILE;
  const windowDays = opts.windowDays ?? FORMAT_BARS_DEFAULT_WINDOW_DAYS;
  const minCohort = opts.minCohort ?? 5;

  const rows = await db.execute<{
    post_type: string;
    checkpoint_key: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      pi.post_type,
      vs.checkpoint_key,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY vs.views) AS p,
      count(*) AS cohort_size
    FROM production_items pi
    JOIN view_snapshots vs ON vs.production_item_id = pi.id
    WHERE pi.post_type IS NOT NULL
      AND pi.status = 'Published'
      AND pi.deleted_at IS NULL
      AND vs.checkpoint_key IS NOT NULL
      AND vs.views IS NOT NULL
      AND pi.published_at >= (now() - interval '${sql.raw(String(windowDays))} days')
    GROUP BY pi.post_type, vs.checkpoint_key
    HAVING count(*) >= ${minCohort}
  `);

  const bars: PostTypeCheckpointBars = {};
  for (const row of rows) {
    if (!bars[row.post_type]) bars[row.post_type] = {};
    bars[row.post_type][row.checkpoint_key] = {
      p: Number(row.p),
      percentile,
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}

export async function fetchFormatCheckpointBars(
  opts: FetchFormatCheckpointBarsOptions = {}
): Promise<FormatCheckpointBars> {
  const percentile = opts.percentile ?? FORMAT_BARS_DEFAULT_PERCENTILE;
  const windowDays = opts.windowDays ?? FORMAT_BARS_DEFAULT_WINDOW_DAYS;
  const minCohort = opts.minCohort ?? 5;

  const rows = await db.execute<{
    format: string;
    post_type: string;
    checkpoint_key: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      pi.format AS format,
      pi.post_type,
      vs.checkpoint_key,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY vs.views) AS p,
      count(*) AS cohort_size
    FROM production_items pi
    JOIN view_snapshots vs ON vs.production_item_id = pi.id
    WHERE pi.format IS NOT NULL
      AND pi.post_type IS NOT NULL
      AND pi.status = 'Published'
      AND pi.deleted_at IS NULL
      AND vs.checkpoint_key IS NOT NULL
      AND vs.views IS NOT NULL
      AND pi.published_at >= (now() - interval '${sql.raw(String(windowDays))} days')
    GROUP BY pi.format, pi.post_type, vs.checkpoint_key
    HAVING count(*) >= ${minCohort}
  `);

  const bars: FormatCheckpointBars = {};
  for (const row of rows) {
    if (!bars[row.format]) bars[row.format] = {};
    if (!bars[row.format][row.post_type]) bars[row.format][row.post_type] = {};
    bars[row.format][row.post_type][row.checkpoint_key] = {
      p: Number(row.p),
      percentile,
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}
