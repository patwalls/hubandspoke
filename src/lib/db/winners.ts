import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pickWinners, type Winner, type WinnerCandidate } from "@/lib/winners/pick";
import { shouldEstimate } from "@/lib/services/view-estimator";
import type { WinNote } from "@/lib/db/schema";

export interface WinnerRow extends WinnerCandidate {
  format: string | null;
  platform: string | null;
  accountHandle: string | null;
  thumbnail: string | null;
  publishedAt: string;
  postType: string;
  /** "Why it won" — written by the winner-notes cron; null until then. */
  winNote: WinNote | null;
}

/**
 * Posts published in the last `days` days on `brand` that beat the median of
 * their own account + post type over the 90 days before them. Ranking rules
 * live in `pickWinners`; this only fetches candidates with their baseline.
 */
export async function getRecentWinners(
  brand: string,
  { days = 7, limit = 5 }: { days?: number; limit?: number } = {},
): Promise<Winner<WinnerRow>[]> {
  const rows = await db.execute<{
    id: string;
    title: string | null;
    views: number;
    likes: number | null;
    post_type: string;
    format: string | null;
    platform: string | null;
    account_handle: string | null;
    thumbnail: string | null;
    published_at: string;
    win_note: WinNote | null;
    baseline_median: string | number | null;
    baseline_posts: string | number;
    baseline_likes_median: string | number | null;
  }>(sql`
    WITH recent AS (
      SELECT p.id, p.title, p.views, p.likes, p.format, p.thumbnail, p.published_at, p.win_note,
             p.account_id, coalesce(p.post_type, '') AS post_type,
             a.platform, a.handle AS account_handle
        FROM production_items p
        JOIN accounts a ON a.id = p.account_id
       WHERE p.brand = ${brand}
         AND p.deleted_at IS NULL
         AND p.views IS NOT NULL
         AND p.published_at > now() - make_interval(days => ${days})
    ),
    baseline AS (
      SELECT b.account_id, coalesce(b.post_type, '') AS post_type,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY b.views) AS median,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY b.likes) AS likes_median,
             count(*) AS posts
        FROM production_items b
       WHERE b.account_id IN (SELECT account_id FROM recent)
         AND b.deleted_at IS NULL
         AND b.views IS NOT NULL
         AND b.published_at > now() - make_interval(days => ${days} + 90)
         AND b.published_at <= now() - make_interval(days => ${days})
       GROUP BY 1, 2
    )
    SELECT r.id, r.title, r.views, r.likes, r.post_type, r.format, r.platform, r.account_handle,
           r.thumbnail, r.published_at, r.win_note,
           bl.median AS baseline_median, coalesce(bl.posts, 0) AS baseline_posts,
           bl.likes_median AS baseline_likes_median
      FROM recent r
      LEFT JOIN baseline bl ON bl.account_id = r.account_id AND bl.post_type = r.post_type
  `);

  const candidates: WinnerRow[] = Array.from(rows).map((r) => ({
    id: r.id,
    title: r.title,
    views: Number(r.views),
    baselineMedian: Number(r.baseline_median ?? 0),
    baselinePosts: Number(r.baseline_posts),
    // Estimated-view post types are judged on likes (see pick.ts header).
    metric: shouldEstimate(r.post_type) ? "likes" : "views",
    likes: Number(r.likes ?? 0),
    baselineLikesMedian: Number(r.baseline_likes_median ?? 0),
    format: r.format,
    platform: r.platform,
    accountHandle: r.account_handle,
    thumbnail: r.thumbnail,
    publishedAt: new Date(r.published_at).toISOString(),
    postType: r.post_type,
    winNote: r.win_note ?? null,
  }));
  return pickWinners(candidates, { limit });
}
