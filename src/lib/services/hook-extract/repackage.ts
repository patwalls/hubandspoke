/**
 * Format-aware rules for "Reel: Repackage Section w/ Hook" content.
 *
 * Why this lives here:
 * In this format the editor manually types the on-video burn-in overlay text
 * into the `title` field when packaging the clip. The hook-extraction
 * dispatcher would otherwise let Haiku pick between title/caption/transcript
 * and frequently picks the IG caption (which is the longer story) over the
 * short overlay. Since the overlay IS the hook for this format by editorial
 * convention, we short-circuit: title → overlay column AND title → hook with
 * `hook_source='overlay'`. Same predicate is reused by the
 * production-items PATCH handler so editor edits to title stay in sync.
 *
 * Scope is intentionally narrow:
 * - Only the two known format names that mean "Reel with hook overlay"
 * - Only IG (instagram_reel / instagram_post) where the title is the editor's
 *   typed overlay. Cross-posts (X/TikTok/YT) auto-generate titles like
 *   "Reel → X (...)", which would corrupt hook if we copied them.
 * - Only source_type IN ('original','repost') for the same reason.
 */

export const REPACKAGE_OVERLAY_FORMATS = new Set<string>([
  "Reel: Repackage Section w/ Hook",
  "Repackage section with hook", // legacy variant
]);

const REPACKAGE_POST_TYPES = new Set<string>([
  "instagram_reel",
  "instagram_post",
]);

const REPACKAGE_SOURCE_TYPES = new Set<string>(["original", "repost"]);

export interface RepackageOverlayCandidate {
  format: string | null | undefined;
  postType: string | null | undefined;
  sourceType: string | null | undefined;
  title: string | null | undefined;
}

export function isRepackageOverlayItem(
  item: RepackageOverlayCandidate
): boolean {
  if (!REPACKAGE_OVERLAY_FORMATS.has(item.format ?? "")) return false;
  if (!REPACKAGE_POST_TYPES.has(item.postType ?? "")) return false;
  if (!REPACKAGE_SOURCE_TYPES.has(item.sourceType ?? "")) return false;
  return !!item.title?.trim();
}
