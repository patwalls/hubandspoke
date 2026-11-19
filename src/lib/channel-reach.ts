// What a cross-post target usually gets: the picker shows each target's
// typical views over its last 30 days of published posts, so whoever picks
// targets sees which channels pay back the posting time. Pure so the rule is
// unit-tested; the aggregates come from the cross-post-usual route.

export interface ChannelReach {
  /** Published posts on this (account, postType) in the window. */
  posts: number;
  /** Median views over those posts (null when none has views). */
  medianViews: number | null;
  /** Posts whose likes were reported as exactly 0. */
  zeroLikes: number;
}

/** Fewer posts than this and a median is noise — show nothing. */
export const REACH_MIN_POSTS = 5;
/** At least this share of posts with no likes reads as "mostly no likes". */
export const REACH_QUIET_SHARE = 0.5;
export const REACH_WINDOW_DAYS = 30;

/** 1234 → "1.2K", 15400 → "15K", 2_100_000 → "2.1M". */
export function compactViews(n: number): string {
  const r = Math.round(n);
  if (r < 1000) return String(r);
  if (r < 999_500) {
    const k = r / 1000;
    return `${k < 10 ? Math.round(k * 10) / 10 : Math.round(k)}K`;
  }
  const m = r / 1_000_000;
  return `${m < 10 ? Math.round(m * 10) / 10 : Math.round(m)}M`;
}

export interface ChannelReachLabel {
  /** Short text on the row, e.g. "~1.6K views". */
  text: string;
  /** Tooltip with the numbers behind it. */
  title: string;
  /** Most posts here got no likes — the row says so, in amber. */
  quiet: boolean;
}

/** The row's reach label, or null when there's too little history. */
export function channelReachLabel(r: ChannelReach | undefined): ChannelReachLabel | null {
  if (!r || r.posts < REACH_MIN_POSTS || r.medianViews == null) return null;
  const quiet = r.zeroLikes / r.posts >= REACH_QUIET_SHARE;
  const views = `~${compactViews(r.medianViews)} views`;
  const text = quiet ? `${views} · mostly no likes` : views;
  const title =
    `Last ${REACH_WINDOW_DAYS} days: ${r.posts} posts here, typical post ` +
    `${Math.round(r.medianViews).toLocaleString("en-US")} views` +
    (r.zeroLikes > 0 ? `, ${r.zeroLikes} of ${r.posts} got no likes.` : ".");
  return { text, title, quiet };
}
