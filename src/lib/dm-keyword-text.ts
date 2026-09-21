/**
 * The DM keyword inside post copy. A post's caption (and its design) says
 * "comment HOUND and I'll DM you the link"; when the keyword attached to
 * the post changes, the copy has to follow. Pure — used by the editors'
 * Post tab. The keyword is a short-link slug; on screen it is always
 * upper-cased (that is how ManyChat matches it and how every post shows
 * it).
 */

/** Where the caption mentions the keyword: whole word, any case. */
export function captionMentionsKeyword(caption: string, keyword: string): boolean {
  return keywordPattern(keyword).test(caption);
}

/** Swap the old keyword for the new one everywhere the caption says it.
 *  Returns the caption unchanged when the old one isn't there. */
export function replaceKeywordInCaption(caption: string, prev: string | null, next: string | null): string {
  if (!prev || !next || prev.toLowerCase() === next.toLowerCase()) return caption;
  return caption.replace(keywordPattern(prev), next.toUpperCase());
}

/** The line to add when the caption doesn't mention the keyword at all. */
export function keywordCtaLine(keyword: string): string {
  return `Comment "${keyword.toUpperCase()}" and I'll DM you the link.`;
}

function keywordPattern(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-bounded so "hound" never matches inside "greyhound"; the slug's own
  // characters are letters/digits/dashes, so \b works at both ends.
  return new RegExp(`\\b${escaped}\\b`, "gi");
}
