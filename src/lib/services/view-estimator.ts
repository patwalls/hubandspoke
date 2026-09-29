/**
 * View estimation via likes multipliers.
 *
 * Some platforms don't return real view/impression counts via API.
 * We estimate views by multiplying the like count by a post-type-specific
 * ratio derived from historical data (mirrors Starter Story's
 * get_performance_data.rb).
 *
 * Post types that use estimation:
 *   instagram_post     → 137x  (based on 5 posts, avg 137)
 *   linkedin           → 163x  (based on 12 posts, avg 163)
 *   threads            → 150x  (clamped from median 165 / avg 182). SC
 *                              returns view_counts for Threads but it's
 *                              wrong on fresh posts — observed 2.5x and
 *                              11.9x like/view ratios that don't match
 *                              the Threads UI. Always estimate.
 *   youtube_community  → 194x  (based on 12 posts, avg 194)
 *   facebook_post      → 165x  (median 168 over 121 posts, Jul–Sep 2026 FB
 *                              analytics export). SC's /facebook/profile/posts
 *                              returns NO view count for any post — photo or
 *                              video (videoViewCount comes back null on our
 *                              page) — so reactions (SC `reactionCount`) are
 *                              the only anchor. Weaker than the others:
 *                              ~±47% per-post error, and top posts undercount
 *                              (aggregate ratio 461x). Use for trend, not as a
 *                              precise per-post number.
 *
 * Post types with real view data (no estimation):
 *   youtube_long, youtube_shorts, instagram_reel, x, tiktok
 */

export const POST_TYPE_VIEW_MULTIPLIERS: Record<string, number> = {
  linkedin: 163,
  threads: 150,
  youtube_community: 194,
  instagram_post: 137,
  facebook_post: 165,
};

/**
 * Returns estimated views and whether estimation was applied.
 * Returns { views: null, estimated: false } if the post type doesn't need
 * estimation or if likes are missing.
 */
export function estimateViewsFromLikes(
  postType: string | null | undefined,
  likes: number | null | undefined
): { views: number | null; estimated: boolean } {
  if (!likes || likes <= 0) return { views: null, estimated: false };
  if (!postType) return { views: null, estimated: false };
  const multiplier = POST_TYPE_VIEW_MULTIPLIERS[postType];
  if (!multiplier) return { views: null, estimated: false };
  return { views: Math.round(likes * multiplier), estimated: true };
}

/** True when the post type uses likes-based view estimation. */
export function shouldEstimate(postType: string | null | undefined): boolean {
  return !!postType && postType in POST_TYPE_VIEW_MULTIPLIERS;
}
