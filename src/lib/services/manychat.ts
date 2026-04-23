// IG comment-to-DM integration helpers.
//
// Two dispatchers can call the lookup:
//   - The Meta Graph API direct path (preferred): `/api/instagram/webhook`
//     receives a comment event from Meta, calls `findKeywordMatch` directly,
//     and sends a private reply via Meta's Send API.
//   - The legacy ManyChat path: `/api/manychat/lookup` exposes the same logic
//     over HTTP for the ManyChat External Request action. Kept during the
//     migration to Meta direct; will be removed once Meta is verified.
//
// `normalizeKeyword` is the single source of truth for matching — write path
// (form/API persists the normalized value) and read path (lookup normalizes
// inbound text before matching). Same function on both sides means
// case/whitespace differences never silently miss.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

// Response sent back to ManyChat's External Request action. `found` is a
// "Yes" | "No" string (not a boolean) because the receiving Custom Field is
// text-typed in ManyChat — the Condition step compares it via string equality.
export type ManychatLookupResponse = {
  found: "Yes" | "No";
  link: string;
  post_title: string;
};

/**
 * Internal lookup result. Callers translate to their own response shape
 * (ManyChat needs Yes/No strings; Meta direct path just acts on the link).
 */
export type KeywordMatch = {
  link: string;
  post_title: string;
};

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

/**
 * Look up a configured keyword by inbound comment text. Used by both the
 * legacy ManyChat HTTP shim and the Meta Graph API webhook.
 *
 * Match strategy:
 *   1. Exact match on the normalized comment text.
 *   2. Word-boundary contains — so "send me guide saas pls" still matches a
 *      stored keyword of "guide saas".
 *
 * Expected DB size: tens to low thousands of rows. One indexed scan per call.
 *
 * Returns null if the comment doesn't match any configured keyword (or if the
 * comment text is empty/whitespace-only).
 */
export async function findKeywordMatch(
  commentText: string | null | undefined
): Promise<KeywordMatch | null> {
  const normalized = normalizeKeyword(commentText);
  if (!normalized) return null;

  const candidates = await db
    .select({
      keyword: productionItems.manychatKeyword,
      link: productionItems.manychatLink,
      title: productionItems.title,
    })
    .from(productionItems)
    .where(
      sql`${productionItems.manychatKeyword} IS NOT NULL AND ${productionItems.manychatLink} IS NOT NULL`
    );

  // Exact match wins.
  const exact = candidates.find((c) => c.keyword === normalized);
  if (exact && exact.link) {
    return { link: exact.link, post_title: exact.title ?? "" };
  }

  // Word-boundary contains.
  for (const c of candidates) {
    if (!c.keyword || !c.link) continue;
    const escaped = c.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(normalized)) {
      return { link: c.link, post_title: c.title ?? "" };
    }
  }

  return null;
}
