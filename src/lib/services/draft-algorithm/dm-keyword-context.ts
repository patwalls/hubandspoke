import { commentKeywordFor, usesCtaOffer, usesRebrandlyDm } from "@/lib/cta-offer-brands";

// Instagram post types whose caption carries the "comment X and I'll DM you
// the link" CTA (stories have no ManyChat comment trigger).
const DM_CAPTION_POST_TYPES: ReadonlySet<string> = new Set(["instagram_reel", "instagram_post"]);

/**
 * The draft writer's DM KEYWORD context (draft-agent v18) for one post:
 * undefined when the post can't carry a ManyChat keyword (not an Instagram
 * reel/post, or a brand without DM keywords — the offer-path brands other
 * than MATG/MFM); else the word people comment for the attached keyword,
 * or null when none is attached yet (the writer then uses the placeholder).
 */
export function dmKeywordContext(item: { brand: string | null; postType: string | null; shortLinkSlug: string | null }): { word: string | null } | undefined {
  if (!item.postType || !DM_CAPTION_POST_TYPES.has(item.postType)) return undefined;
  if (!item.brand || (usesCtaOffer(item.brand) && !usesRebrandlyDm(item.brand))) return undefined;
  return { word: commentKeywordFor(item.brand, item.shortLinkSlug) };
}
