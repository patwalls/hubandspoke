import type { PostType } from "@/lib/platform-field-schemas";

// Which source post types can be cross-posted verbatim (or near-verbatim)
// to which target post types. "Cross-post" here means paste-don't-rewrite —
// the source caption / video can be re-uploaded to the target with minimal
// transformation. Anything that needs real re-authoring (YouTube long-form
// → Instagram reel, for example) is a *repurpose*, which is a different
// concept handled elsewhere in the app (the formats tree + clip-idea flow).
//
// Each entry is `[source, target]`. Entries are directional — tweet→linkedin
// is a natural cross-post, but linkedin→tweet usually needs trimming, so we
// list both directions explicitly where they apply. Keep this small and
// conservative; the goal is "obvious fits only," not "anywhere you could
// technically paste it."
export const CROSS_POST_COMPAT: ReadonlyArray<readonly [PostType, PostType]> = [
  // text → text
  ["x", "linkedin"],
  ["x", "threads"],
  ["x", "youtube_community"],
  ["threads", "x"],
  ["threads", "linkedin"],
  ["linkedin", "x"],
  ["linkedin", "threads"],
  // vertical short-form video → vertical short-form video
  ["instagram_reel", "tiktok"],
  ["instagram_reel", "youtube_shorts"],
  ["tiktok", "instagram_reel"],
  ["tiktok", "youtube_shorts"],
  ["youtube_shorts", "instagram_reel"],
  ["youtube_shorts", "tiktok"],
];

export function isCrossPostCompatible(
  source: PostType,
  target: PostType
): boolean {
  if (source === target) return false;
  return CROSS_POST_COMPAT.some(([s, t]) => s === source && t === target);
}

export function compatibleTargetsFor(source: PostType): PostType[] {
  return CROSS_POST_COMPAT.filter(([s]) => s === source).map(([, t]) => t);
}

export function hasAnyCompatibleTarget(source: PostType): boolean {
  return CROSS_POST_COMPAT.some(([s]) => s === source);
}
