// ManyChat IG comment-to-DM integration helpers.
//
// Architecture: ManyChat fires External Request → /api/manychat/lookup with the
// raw IG comment text. We normalize and look up against
// productionItems.manychatKeyword. Per-post phrase + link live entirely in our
// DB; ManyChat is dumb plumbing.
//
// normalizeKeyword is the single source of truth for both sides — write path
// (form/API persists the normalized value) and read path (lookup normalizes
// inbound `comment_text` before matching). Same function on both sides means
// case/whitespace differences never silently miss.

export type ManychatLookupResponse =
  | { found: true; link: string; post_title: string }
  | { found: false; link: ""; post_title: "" };

/**
 * Normalize a ManyChat keyword for storage and lookup.
 * - Lowercase (case-insensitive matching)
 * - Trim outer whitespace
 * - Collapse internal whitespace to single spaces
 *
 * Returns null for empty/whitespace-only input so callers can store NULL
 * (the partial unique index is on `manychat_keyword IS NOT NULL`).
 */
export function normalizeKeyword(input: string | null | undefined): string | null {
  if (input == null) return null;
  const collapsed = input.trim().toLowerCase().replace(/\s+/g, " ");
  return collapsed.length === 0 ? null : collapsed;
}

const KEYWORD_PATTERN = /^[a-z0-9 _-]{3,32}$/;

/**
 * Validate a NORMALIZED keyword. Call after `normalizeKeyword`.
 * Constraints: 3-32 chars, lowercase alphanumeric + space/hyphen/underscore.
 * Spaces are allowed because IG commenters type natural phrases ("get saas"),
 * not slugs.
 */
export function isValidKeyword(normalized: string): boolean {
  return KEYWORD_PATTERN.test(normalized);
}

/**
 * Validate a destination link. Must be an absolute https:// URL.
 */
export function isValidLink(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}
