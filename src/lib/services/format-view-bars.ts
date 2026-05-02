import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Per-format P75 view threshold over a rolling window. Used by the
// cross-post candidate finder ("is this post in the top quartile of its
// format?") and by the Content table's vs-P75 badge column.
//
// Cross-brand by design: a format like "Reel: Repackage Section w/ Hook"
// has a single bar across every brand that posts in that format. Brands
// can compare apples to apples without the cohort silently shifting.

export const FORMAT_BARS_WINDOW_DAYS = 90;
export const FORMAT_BARS_PERCENTILE = 0.75;
export const FORMAT_BARS_MIN_COHORT = 10;

export interface FormatBar {
  p75: number;
  cohortSize: number;
}

export type FormatBars = Record<string, FormatBar>;

export async function fetchFormatViewBars(): Promise<FormatBars> {
  const rows = await db.execute<{
    format: string;
    p75: string;
    cohort_size: string;
  }>(sql`
    SELECT
      format,
      percentile_cont(${FORMAT_BARS_PERCENTILE}) WITHIN GROUP (ORDER BY views) AS p75,
      count(*) AS cohort_size
    FROM production_items
    WHERE format IS NOT NULL
      AND status = 'Published'
      AND deleted_at IS NULL
      AND views IS NOT NULL
      AND published_at >= (now() - interval '${sql.raw(String(FORMAT_BARS_WINDOW_DAYS))} days')
    GROUP BY format
    HAVING count(*) >= ${FORMAT_BARS_MIN_COHORT}
  `);

  const bars: FormatBars = {};
  for (const row of rows) {
    bars[row.format] = {
      p75: Number(row.p75),
      cohortSize: Number(row.cohort_size),
    };
  }
  return bars;
}
