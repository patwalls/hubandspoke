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

// ── Monday email: quiet channels ─────────────────────────────────────────
// The winners email names, per brand, the channels where most posts got no
// likes — enough posts that it's a pattern, not a slow week — so whoever
// plans cross-posts can decide if they're worth the editor time.

/** A channel needs at least this many posts in the window to be called quiet. */
export const QUIET_EMAIL_MIN_POSTS = 10;

export interface QuietChannelRow extends ChannelReach {
  handle: string;
  postType: string;
}

/** Channels with ≥ QUIET_EMAIL_MIN_POSTS posts and ≥ half of them at 0
 *  likes, most no-like posts first. Rows with no reported likes count as
 *  likes > 0 (unknown is not quiet). */
export function quietChannels(rows: QuietChannelRow[]): QuietChannelRow[] {
  return rows
    .filter((r) => r.posts >= QUIET_EMAIL_MIN_POSTS && r.zeroLikes / r.posts >= REACH_QUIET_SHARE)
    .sort((a, b) => b.zeroLikes - a.zeroLikes || a.handle.localeCompare(b.handle));
}

export interface AccountReachLine extends ChannelReachLabel {
  postType: string;
}

/** The Accounts page's "Typical post" cell for one account: a label per post
 *  type that has enough history, busiest type first. `reach` is keyed
 *  `<accountId>:<postType>` (fetchChannelReach). Empty = render nothing. */
export function accountReachLines(
  reach: Record<string, ChannelReach>,
  accountId: string,
): AccountReachLine[] {
  const prefix = `${accountId}:`;
  return Object.entries(reach)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, r]) => ({ postType: key.slice(prefix.length), r, label: channelReachLabel(r) }))
    .filter((x): x is { postType: string; r: ChannelReach; label: ChannelReachLabel } => x.label != null)
    .sort((a, b) => b.r.posts - a.r.posts || a.postType.localeCompare(b.postType))
    .map(({ postType, label }) => ({ postType, ...label }));
}
