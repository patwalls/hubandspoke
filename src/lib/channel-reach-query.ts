import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { REACH_WINDOW_DAYS, type ChannelReach } from "@/lib/channel-reach";

/** Each (account, postType) of the brand: its published posts in the last
 *  REACH_WINDOW_DAYS, their median views and how many got no likes, keyed
 *  `<accountId>:<postType>` like the picker's target keys. One grouped scan
 *  over the published-date index; ~10–50 rows per brand. Shared by the post
 *  page's Cross-post tab (cross-post-usual route) and the cross-post queue. */
export async function fetchChannelReach(brand: string): Promise<Record<string, ChannelReach>> {
  const rows = await db.execute<{
    account_id: string;
    post_type: string;
    posts: number;
    median_views: number | null;
    zero_likes: number;
  }>(sql`
    SELECT account_id, post_type,
           count(*)::int AS posts,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY views)::float8 AS median_views,
           (count(*) FILTER (WHERE likes = 0))::int AS zero_likes
    FROM production_items
    WHERE brand = ${brand}
      AND status = 'Published'
      AND published_link IS NOT NULL
      AND account_id IS NOT NULL AND post_type IS NOT NULL
      AND published_date >= (now() - make_interval(days => ${REACH_WINDOW_DAYS}))::date
    GROUP BY account_id, post_type`);
  const out: Record<string, ChannelReach> = {};
  for (const r of rows) {
    out[`${r.account_id}:${r.post_type}`] = {
      posts: Number(r.posts),
      medianViews: r.median_views == null ? null : Number(r.median_views),
      zeroLikes: Number(r.zero_likes),
    };
  }
  return out;
}
