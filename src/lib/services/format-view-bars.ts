import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Per-format view bars over a rolling window. Two flavors:
//
//   1. Lifetime bars — `fetchFormatViewBars` — percentile of cumulative
//      `production_items.views` for posts in a format. Drives the Content
//      tab's "vs P75" badge and the cross-post queue's lifetime gate.
//
//   2. Velocity bars — `fetchFormatCheckpointBars` — percentile of
//      `view_snapshots.views` at each capture-velocity-snapshot
//      checkpoint (15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h). Drives the
//      cross-post queue's age-fair gate so a 6-hour-old rocket isn't
//      penalized against a cohort that's had days to mature.
//
// Cross-brand cohort by design — a format like "Reel: Repackage Section
// w/ Hook" has the same bar across every brand that posts in it.

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

export type FormatBars = Record<string, FormatBar>;

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
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      format,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY views) AS p,
      count(*) AS cohort_size
    FROM production_items
    WHERE format IS NOT NULL
      AND status = 'Published'
      AND deleted_at IS NULL
      AND views IS NOT NULL
      AND published_at >= (now() - interval '${sql.raw(String(windowDays))} days')
    GROUP BY format
    HAVING count(*) >= ${minCohort}
  `);

  const bars: FormatBars = {};
  for (const row of rows) {
    bars[row.format] = {
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

/** Map<format, Map<checkpoint_key, bar>>. Checkpoint keys come from
 *  VELOCITY_CHECKPOINTS in src/lib/velocity-checkpoints.ts. */
export type FormatCheckpointBars = Record<
  string,
  Record<string, CheckpointBar>
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
    checkpoint_key: string;
    p: string;
    cohort_size: string;
  }>(sql`
    SELECT
      pi.format AS format,
      vs.checkpoint_key,
      percentile_cont(${percentile}) WITHIN GROUP (ORDER BY vs.views) AS p,
      count(*) AS cohort_size
    FROM production_items pi
    JOIN view_snapshots vs ON vs.production_item_id = pi.id
    WHERE pi.format IS NOT NULL
      AND pi.status = 'Published'
      AND pi.deleted_at IS NULL
      AND vs.checkpoint_key IS NOT NULL
      AND vs.views IS NOT NULL
      AND pi.published_at >= (now() - interval '${sql.raw(String(windowDays))} days')
    GROUP BY pi.format, vs.checkpoint_key
    HAVING count(*) >= ${minCohort}
  `);

  const bars: FormatCheckpointBars = {};
  for (const row of rows) {
    if (!bars[row.format]) bars[row.format] = {};
    bars[row.format][row.checkpoint_key] = {
      p: Number(row.p),
      percentile,
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}
