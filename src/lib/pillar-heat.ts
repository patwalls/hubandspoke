/**
 * How a pillar video is doing next to its own channel: views ÷ the median
 * views of the channel's other videos in the same list (the pickers show the
 * last 60–120 days). Shown in the New-menu pillar pickers so the hot ones
 * stand out. Needs 3+ channel videos with views to say anything; a channel
 * of one video, or a video without views, gets null. Young videos read low:
 * they haven't had the time, which is fine for "what has done well lately".
 */
export function withPillarHeat<T extends { accountId: string | null; views: number | null }>(
  videos: T[],
): (T & { heat: number | null })[] {
  const byChannel = new Map<string, number[]>();
  for (const v of videos) {
    if (v.accountId == null || v.views == null) continue;
    byChannel.set(v.accountId, [...(byChannel.get(v.accountId) ?? []), v.views]);
  }
  const median = new Map<string, number>();
  for (const [id, views] of byChannel) {
    if (views.length < 3) continue;
    const s = [...views].sort((a, b) => a - b);
    const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    if (m > 0) median.set(id, m);
  }
  return videos.map((v) => {
    const m = v.accountId != null ? median.get(v.accountId) : undefined;
    return { ...v, heat: m && v.views != null ? Math.round((v.views / m) * 10) / 10 : null };
  });
}

/** A hot video: at least twice its channel's typical views. */
export const HOT_HEAT = 2;
