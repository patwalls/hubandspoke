// "💬 2" on the In Production list: someone else commented on this post
// recently, so the person walking the list sees fresh feedback without opening
// every post. The report carries each post's open comments from the last
// RECENT_COMMENT_HOURS (it is cached and shared by everyone); who counts as
// "someone else" is decided here, per viewer, at render time.

import type { RecentComment } from "@/types";

export const RECENT_COMMENT_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

export interface NewComments {
  count: number;
  /** "2 new comments in the last 2 days · latest from Kate, 3h ago" */
  title: string;
}

function ago(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/** Comments from people other than `viewerId` within the window, or null
 *  when there are none. A comment with no known author (synced from Notion)
 *  counts — it is never the viewer's own. Bad timestamps never count. */
export function newCommentsFor(
  comments: readonly RecentComment[] | null | undefined,
  viewerId: string | null | undefined,
  now: number = Date.now(),
): NewComments | null {
  if (!comments?.length) return null;
  const fresh = comments
    .map((c) => ({ c, t: new Date(c.at).getTime() }))
    .filter(
      ({ c, t }) =>
        Number.isFinite(t) &&
        now - t <= RECENT_COMMENT_HOURS * HOUR_MS &&
        !(viewerId && c.byUserId === viewerId),
    )
    .sort((a, b) => b.t - a.t);
  if (fresh.length === 0) return null;
  const latest = fresh[0];
  const noun = fresh.length === 1 ? "new comment" : "new comments";
  const from = latest.c.by ? ` from ${latest.c.by},` : "";
  return {
    count: fresh.length,
    title: `${fresh.length} ${noun} in the last 2 days · latest${from} ${ago(now - latest.t)}`,
  };
}
