import { sql } from "drizzle-orm";
import { startOfWeek } from "date-fns";
import { db } from "@/lib/db";
import { getEnabledBrands } from "@/lib/db/brands";
import { getWeekProgress, type WeekStartsOn } from "@/lib/utils/dates";
import { paceOf, sortByPace, type BrandPaceRow } from "./pace";

/**
 * Every enabled brand's week so far, sorted off-pace first. Same counting
 * rules as the brand dashboard's week-over-week tile
 * (`getWeekOverWeekComparison` in src/lib/db/queries.ts): Published, not
 * deleted, by published_at (falling back to published_date), in the brand's
 * own week (its `week_start_day`).
 */
export async function getBrandPace(now: Date = new Date()): Promise<BrandPaceRow[]> {
  const brandRows = await getEnabledBrands();
  const rows = await Promise.all(
    brandRows.map(async (b) => {
      const weekStartsOn = normalize(b.weekStartDay);
      const weekStart = startOfWeek(now, { weekStartsOn });
      const elapsedMs = now.getTime() - weekStart.getTime();
      const priorStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
      const priorAnchor = new Date(priorStart.getTime() + elapsedMs);
      const [r] = (await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE t >= ${weekStart.toISOString()}::timestamptz AND t <= ${now.toISOString()}::timestamptz)::int AS posts,
          COUNT(*) FILTER (WHERE t >= ${priorStart.toISOString()}::timestamptz AND t <= ${priorAnchor.toISOString()}::timestamptz)::int AS prior_posts,
          COALESCE(SUM(views) FILTER (WHERE t >= ${weekStart.toISOString()}::timestamptz AND t <= ${now.toISOString()}::timestamptz), 0)::bigint AS views
        FROM (
          SELECT COALESCE(pi.published_at, pi.published_date::timestamptz) AS t, pi.views
          FROM production_items pi
          WHERE pi.brand = ${b.slug}
            AND pi.status = 'Published'
            AND pi.deleted_at IS NULL
            AND COALESCE(pi.published_at, pi.published_date::timestamptz) >= ${priorStart.toISOString()}::timestamptz
        ) x
      `)) as unknown as Array<{ posts: number; prior_posts: number; views: string | number }>;
      return paceOf({
        slug: b.slug,
        label: b.label,
        posts: Number(r?.posts ?? 0),
        priorPosts: Number(r?.prior_posts ?? 0),
        views: Number(r?.views ?? 0),
        weeklyGoal: b.weeklyGoal,
        weekFraction: getWeekProgress(weekStartsOn, now).percent / 100,
      });
    }),
  );
  return sortByPace(rows);
}

function normalize(d: number | null | undefined): WeekStartsOn {
  const n = Number(d ?? 0);
  return (n >= 0 && n <= 6 ? n : 0) as WeekStartsOn;
}
