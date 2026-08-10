// Per-brand status palette tokens. Statuses are stored in `brand_statuses`
// with a color *token* (e.g. "yellow"); the token is resolved to Tailwind
// classes via this map. Listing the literal classnames here keeps Tailwind
// JIT from stripping them from the bundle.
export const STATUS_COLOR_TOKENS = {
  zinc: "bg-zinc-100 text-zinc-700 border-zinc-200",
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  red: "bg-red-100 text-red-800 border-red-200",
  orange: "bg-orange-100 text-orange-800 border-orange-200",
  amber: "bg-amber-100 text-amber-900 border-amber-200",
  yellow: "bg-yellow-100 text-yellow-800 border-yellow-200",
  green: "bg-green-100 text-green-800 border-green-200",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-200",
  teal: "bg-teal-100 text-teal-800 border-teal-200",
  sky: "bg-sky-100 text-sky-800 border-sky-200",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
  violet: "bg-violet-100 text-violet-800 border-violet-200",
  pink: "bg-pink-100 text-pink-800 border-pink-200",
  rose: "bg-rose-100 text-rose-800 border-rose-200",
} as const;

export type StatusColorToken = keyof typeof STATUS_COLOR_TOKENS;

// Small swatch (just bg + border) for color-picker UI.
export const STATUS_COLOR_SWATCH: Record<StatusColorToken, string> = {
  zinc: "bg-zinc-200 border-zinc-300",
  slate: "bg-slate-200 border-slate-300",
  red: "bg-red-200 border-red-300",
  orange: "bg-orange-200 border-orange-300",
  amber: "bg-amber-200 border-amber-300",
  yellow: "bg-yellow-200 border-yellow-300",
  green: "bg-green-200 border-green-300",
  emerald: "bg-emerald-200 border-emerald-300",
  teal: "bg-teal-200 border-teal-300",
  sky: "bg-sky-200 border-sky-300",
  blue: "bg-blue-200 border-blue-300",
  violet: "bg-violet-200 border-violet-300",
  pink: "bg-pink-200 border-pink-300",
  rose: "bg-rose-200 border-rose-300",
};

export function isStatusColorToken(value: unknown): value is StatusColorToken {
  return typeof value === "string" && value in STATUS_COLOR_TOKENS;
}

// Legacy hard-coded palette. Kept as a fallback for any caller not yet wired
// through the brand_statuses palette (e.g. a status name that hasn't been
// seeded for the current brand). Once every consumer is on the dynamic
// palette this can be removed.
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
  "On Hold": "bg-slate-100 text-slate-700 border-slate-200",
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

// Palette-aware: resolves a color *token* (zinc | yellow | …) to Tailwind
// classes. Returns the default badge classes for unknown / missing tokens.
export function statusClassFromToken(
  token: string | null | undefined
): string {
  if (token && token in STATUS_COLOR_TOKENS) {
    return STATUS_COLOR_TOKENS[token as StatusColorToken];
  }
  return DEFAULT_BADGE;
}

// Server-side helper: given a status name and a `(name → token)` palette
// for the brand, return Tailwind classes. Falls back to the legacy
// STATUS_COLORS map when the name isn't in the palette so any not-yet-seeded
// status still renders something reasonable.
export function statusClassWithPalette(
  status: string | null | undefined,
  palette: ReadonlyMap<string, string> | null | undefined
): string {
  if (!status) return DEFAULT_BADGE;
  const token = palette?.get(status);
  if (token && token in STATUS_COLOR_TOKENS) {
    return STATUS_COLOR_TOKENS[token as StatusColorToken];
  }
  return STATUS_COLORS[status] ?? DEFAULT_BADGE;
}

export function postTypeClass(postType: string | null | undefined): string {
  return (postType && POST_TYPE_COLORS[postType]) || DEFAULT_BADGE;
}

export function postTypeLabel(postType: string | null | undefined): string {
  return (postType && POST_TYPE_LABELS[postType]) || "—";
}
