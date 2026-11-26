/**
 * What people read on a post page (post-page-readers M1). Ten of the eleven
 * people who open posts mostly read them; these marks say what they read,
 * so the next milestone puts the right thing first for them. No UI change.
 *
 *   content:read:dwell-10s / :dwell-60s — the post stayed open and on screen
 *     that long (tab hidden doesn't count). A view with no dwell-10s is a
 *     bounce.
 *   content:read:activity — the Activity feed was at least half in view
 *     for 1.5 s.
 *   content:read:preview-play — a video in the preview/player was played.
 *
 * Each fires at most once per post open.
 */
export const DWELL_MARKS = [
  { afterMs: 10_000, mark: "content:read:dwell-10s" },
  { afterMs: 60_000, mark: "content:read:dwell-60s" },
] as const;

export const ACTIVITY_SEEN_MS = 1_500;
export const ACTIVITY_MARK = "content:read:activity";
export const PREVIEW_PLAY_MARK = "content:read:preview-play";

/** The dwell marks newly due after `visibleMs` of on-screen time. */
export function dwellMarksDue(visibleMs: number, fired: ReadonlySet<string>): string[] {
  return DWELL_MARKS.filter((d) => visibleMs >= d.afterMs && !fired.has(d.mark)).map((d) => d.mark);
}
