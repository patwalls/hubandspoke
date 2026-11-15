const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// Order-independent: lookahead for data-type="mention", then capture data-id.
const MENTION_SPAN_RE = new RegExp(
  `<span(?=[^>]*\\bdata-type="mention")[^>]*\\bdata-id="(${UUID_PATTERN})"`,
  "gi",
);

export function extractMentionUserIds(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(MENTION_SPAN_RE)) {
    ids.add(match[1].toLowerCase());
  }
  return [...ids];
}

const MENTION_SPAN_BLOCK_RE =
  /<span(?=[^>]*\bdata-type="mention")[^>]*>[\s\S]*?<\/span>/gi;

/**
 * True when a comment is nothing but @-mentions: no words, no image, no link.
 * The curator's "assign, then @ them" habit posts exactly this a few seconds
 * after the assignment email went out; such a ping carries nothing the
 * assignment email didn't, so its email is folded into it (see
 * `enqueueNotification`'s `foldIntoRecentAssignment`). Structural HTML check
 * only — it never reads what the words say.
 */
export function isMentionOnly(html: string): boolean {
  if (extractMentionUserIds(html).length === 0) return false;
  const rest = html.replace(MENTION_SPAN_BLOCK_RE, "");
  if (/<(img|a|video|iframe)\b/i.test(rest)) return false;
  const text = rest
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;| /gi, " ")
    .trim();
  return text === "";
}
