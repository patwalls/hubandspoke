import type { PostType } from "@/lib/platform-field-schemas";

// Cross-post proximity tiers. Drives how aggressively the draft-agent
// should rewrite a source post for a target platform.
//
// - same_surface: X ↔ Threads. Identical short-form text feeds — output
//   should be near-verbatim, only adjusting for length cap.
// - same_family: pairs within the text-primary triad (x / threads /
//   linkedin) that aren't same_surface, and visual-primary pairs that
//   share a caption convention (instagram_post / instagram_reel /
//   instagram_story / tiktok). Preserve voice and structure; tighten or
//   expand only as the target platform's exemplars demand.
// - cross_family: everything else. The legacy "pull every concrete
//   element / adapt format and voice" directive applies.
export type PlatformProximity =
  | "same_surface"
  | "same_family"
  | "cross_family";

// Explicit pair table — listed unordered (the lookup normalizes the pair).
// Same-surface is X ↔ Threads only; everything else is a judgment call
// the team can extend over time. Adding a new pair here is the supported
// way to widen "preserve verbatim" behavior.
const SAME_SURFACE_PAIRS: ReadonlyArray<readonly [PostType, PostType]> = [
  ["x", "threads"],
];

// Same-family covers crossings where the field shape and voice norms are
// close enough that wholesale rewriting is wrong, but a 280-char tweet
// and a 3000-char LinkedIn post aren't interchangeable. The agent should
// keep the original spine and tighten/expand at the edges.
const SAME_FAMILY_PAIRS: ReadonlyArray<readonly [PostType, PostType]> = [
  // Text-primary triad — x/threads/linkedin all carry a single body
  // field, similar audience expectations, but different length norms.
  ["x", "linkedin"],
  ["threads", "linkedin"],
  // Visual-primary caption family — Instagram post/reel/story and TikTok
  // all sit under a single caption field with comparable conventions.
  ["instagram_post", "instagram_reel"],
  ["instagram_post", "instagram_story"],
  ["instagram_reel", "instagram_story"],
  ["instagram_post", "tiktok"],
  ["instagram_reel", "tiktok"],
];

function pairMatches(
  table: ReadonlyArray<readonly [PostType, PostType]>,
  a: PostType,
  b: PostType,
): boolean {
  for (const [x, y] of table) {
    if ((x === a && y === b) || (x === b && y === a)) return true;
  }
  return false;
}

export function getPlatformProximity(
  sourcePostType: PostType | null | undefined,
  targetPostType: PostType | null | undefined,
): PlatformProximity {
  if (!sourcePostType || !targetPostType) return "cross_family";
  if (sourcePostType === targetPostType) return "same_surface";
  if (pairMatches(SAME_SURFACE_PAIRS, sourcePostType, targetPostType)) {
    return "same_surface";
  }
  if (pairMatches(SAME_FAMILY_PAIRS, sourcePostType, targetPostType)) {
    return "same_family";
  }
  return "cross_family";
}

// Per-tier directive injected into the per-call payload's SOURCE POST
// BODY block. The legacy v7 directive ("pull every concrete element"
// for rich bodies, "change format and voice" for short ones) collapses
// into the cross_family tier here; same_surface and same_family are new.
export function proximityDirective(
  proximity: PlatformProximity,
  sourcePostType: PostType | null | undefined,
  targetPostType: PostType | null | undefined,
): string {
  const src = sourcePostType ?? "(unknown source)";
  const tgt = targetPostType ?? "(unknown target)";
  switch (proximity) {
    case "same_surface":
      return `PROXIMITY: same_surface (${src} ↔ ${tgt}). These platforms are near-identical surfaces. Preserve the source post nearly verbatim — keep the hook, the wording, the line breaks, and the closing. Only adjust if the target platform's character cap requires a trim, or if a specific token (handle, URL shape) needs to swap. Do NOT paraphrase, do NOT reorder, do NOT add new content, do NOT remove existing content.`;
    case "same_family":
      return `PROXIMITY: same_family (${src} → ${tgt}). The platforms share voice and field shape but differ in length norms or audience cadence. Preserve the original's spine — same hook idea, same structure, same named specifics. You may tighten or expand at the edges to fit the target platform's typical length (learn that from the past-caption exemplars), but do not invent new content or restructure the post.`;
    case "cross_family":
      return `PROXIMITY: cross_family (${src} → ${tgt}). The target platform has a different format and voice than the source. Pull EVERY concrete element from the source — every list item, every numbered example, every named person, the hook AND the closing — and retell the idea in the target platform's voice and field schema. Keep facts, numbers, and direct quotes verbatim where possible. Do not collapse the post into a one-line summary of the opener.`;
  }
}
