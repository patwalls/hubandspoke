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
