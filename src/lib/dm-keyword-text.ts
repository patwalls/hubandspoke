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

/** What the draft writer puts in a comment-to-get-the-link CTA when the post
 *  has no keyword yet (draft-agent's DM KEYWORD block): an obvious
 *  placeholder instead of a keyword copied from another post's caption.
 *  Attaching a keyword swaps it in (`followKeywordInCaption`). */
export const KEYWORD_PLACEHOLDER = "KEYWORD";

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

/**
 * The caption after the post's keyword changed to `next`, from the post
 * page's keyword dialog. Two cases:
 *  - the caption says the previous keyword → swap it (`replaceKeywordInCaption`);
 *  - otherwise the caption may carry ANOTHER post's keyword (copied along
 *    with the copy on a cross-post or repost). If exactly one keyword from
 *    the pool appears quoted the way every post shows it (`"SIDEHUSTLE"`,
 *    straight or curly quotes, upper-case), swap just those quoted tokens.
 *    Quoted + upper-case only, so a pool slug that is also an ordinary word
 *    ("launch") never rewrites the sentence it sits in.
 *  - the caption has the draft writer's quoted `"KEYWORD"` placeholder →
 *    swap it (checked before the pool, so a placeholder is never left behind).
 * Returns the caption unchanged when there is nothing (or no single thing)
 * to swap.
 */
export function followKeywordInCaption(caption: string, args: { prev: string | null; next: string | null; pool?: readonly string[] }): string {
  const { prev, next } = args;
  if (!next) return caption;
  if (prev && captionMentionsKeyword(caption, prev)) return replaceKeywordInCaption(caption, prev, next);
  const quoted = (slug: string) => {
    const escaped = slug.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(["“])${escaped}(["”])`, "g");
  };
  const placeholder = quoted(KEYWORD_PLACEHOLDER.toLowerCase());
  if (next.toUpperCase() !== KEYWORD_PLACEHOLDER && placeholder.test(caption)) {
    return caption.replace(placeholder, (_m, open: string, close: string) => `${open}${next.toUpperCase()}${close}`);
  }
  const found = [...new Set((args.pool ?? []).map((s) => s.toLowerCase()))].filter((s) => s !== next.toLowerCase() && quoted(s).test(caption));
  if (found.length !== 1) return caption;
  return caption.replace(quoted(found[0]), (_m, open: string, close: string) => `${open}${next.toUpperCase()}${close}`);
}
