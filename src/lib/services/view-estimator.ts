/**
 * View estimation via likes multipliers.
 *
 * Some platforms don't return real view/impression counts via API.
 * We estimate views by multiplying the like count by a platform-specific ratio
 * derived from historical data (mirrors Starter Story's get_performance_data.rb).
 *
 * Platforms that use estimation:
 *   Instagram Post  → 137x  (based on 5 posts, avg 137)
 *   LinkedIn        → 163x  (based on 12 posts, avg 163)
 *   Threads         → 150x  (clamped to dampen outliers, median 165, avg 182)
 *   YouTube Community → 194x (based on 12 posts, avg 194)
 *
 * Platforms with real view data (no estimation):
 *   YouTube, YouTube Shorts, Instagram Reel, Twitter/X, TikTok
 */

export const PLATFORM_MULTIPLIERS: Record<string, number> = {
  "LinkedIn": 163,
  "Threads": 150,
  "YouTube Community": 194,
  "Instagram Post": 137,
};

/**
 * Returns estimated views and whether estimation was applied.
 * Returns { views: null, estimated: false } if platform doesn't need estimation
 * or if likes are missing.
 */
export function estimateViewsFromLikes(
  platforms: string[],
  likes: number | null | undefined
): { views: number | null; estimated: boolean } {
  if (!likes || likes <= 0) return { views: null, estimated: false };

  for (const p of platforms) {
    const multiplier = PLATFORM_MULTIPLIERS[p];
    if (multiplier) {
      return { views: Math.round(likes * multiplier), estimated: true };
    }
  }

  return { views: null, estimated: false };
}

/**
 * Returns true if any platform in the array uses view estimation.
 */
export function shouldEstimate(platforms: string[]): boolean {
  return platforms.some((p) => p in PLATFORM_MULTIPLIERS);
}
