export const STATUS_COLORS: Record<string, string> = {
  Idea: "bg-zinc-100 text-zinc-700 border-zinc-200",
  "To Assign": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Pre-Production": "bg-pink-100 text-pink-800 border-pink-200",
  "Scoping Call": "bg-zinc-100 text-zinc-700 border-zinc-200",
  Outreach: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Review: "bg-yellow-100 text-yellow-800 border-yellow-200",
  "Yes BUT Later": "bg-green-100 text-green-800 border-green-200",
  "Scheduled Shoot": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Editing (V1)": "bg-amber-100 text-amber-900 border-amber-200",
  "Searching/Planning": "bg-sky-100 text-sky-800 border-sky-200",
  "Graphics (V2)": "bg-zinc-100 text-zinc-700 border-zinc-200",
  "Scoping Call Done": "bg-blue-100 text-blue-800 border-blue-200",
  "Final Review": "bg-orange-100 text-orange-800 border-orange-200",
  "Ready To Publish": "bg-pink-100 text-pink-800 border-pink-200",
  Published: "bg-pink-50 text-pink-700 border-pink-100",
  Killed: "bg-zinc-100 text-zinc-700 border-zinc-200",
  Assigned: "bg-pink-100 text-pink-800 border-pink-200",
};

// Keyed by canonical post_type (src/lib/platform-field-schemas.ts `PostType`).
// Identity (which account) is carried separately by the account pill; this map
// only colors the post shape. Account-specific differentiation (e.g. Pat Walls'
// X vs Starter Story's X) happens via the account handle badge, not color.
export const POST_TYPE_COLORS: Record<string, string> = {
  youtube_long: "bg-rose-100 text-rose-800 border-rose-200",
  youtube_shorts: "bg-zinc-100 text-zinc-700 border-zinc-200",
  youtube_community: "bg-zinc-100 text-zinc-700 border-zinc-200",
  instagram_reel: "bg-emerald-100 text-emerald-800 border-emerald-200",
  instagram_post: "bg-yellow-100 text-yellow-900 border-yellow-200",
  instagram_story: "bg-zinc-100 text-zinc-700 border-zinc-200",
  x: "bg-violet-100 text-violet-800 border-violet-200",
  tiktok: "bg-sky-100 text-sky-800 border-sky-200",
  linkedin: "bg-amber-100 text-amber-900 border-amber-200",
  threads: "bg-pink-50 text-pink-700 border-pink-100",
  newsletter: "bg-pink-100 text-pink-800 border-pink-200",
};

// Human-readable short label for a post type — used in badges alongside the
// account handle.
export const POST_TYPE_LABELS: Record<string, string> = {
  youtube_long: "YouTube",
  youtube_shorts: "YT Shorts",
  youtube_community: "YT Community",
  instagram_reel: "IG Reel",
  instagram_post: "IG Post",
  instagram_story: "IG Story",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  threads: "Threads",
  newsletter: "Newsletter",
};

const DEFAULT_BADGE = "bg-accent text-muted-foreground border-border";

export function statusClass(status: string | null | undefined): string {
  return (status && STATUS_COLORS[status]) || DEFAULT_BADGE;
}

export function postTypeClass(postType: string | null | undefined): string {
  return (postType && POST_TYPE_COLORS[postType]) || DEFAULT_BADGE;
}

export function postTypeLabel(postType: string | null | undefined): string {
  return (postType && POST_TYPE_LABELS[postType]) || "—";
}

/**
 * Back-compat helper for UI that still receives a raw platform string (the
 * legacy channel label, e.g. "YouTube (SS)" / "X (Pat Walls)"). Normalizes
 * via `normalizePlatform` then falls back to the post-type color. Components
 * that have switched to reading `item.postType` should call `postTypeClass`
 * directly.
 *
 * @deprecated Migrate callers to `postTypeClass(item.postType)`.
 */
import { normalizePlatform } from "@/lib/platform-field-schemas";
export function platformClass(platform: string | null | undefined): string {
  if (!platform) return DEFAULT_BADGE;
  const key = normalizePlatform(platform);
  if (key && POST_TYPE_COLORS[key]) return POST_TYPE_COLORS[key];
  return DEFAULT_BADGE;
}
