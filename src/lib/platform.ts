// Notion still owns long-form YouTube pillars — editors work their production
// process inside the source Notion database. Everything else (YouTube Shorts,
// YouTube Community, IG, LinkedIn, X, etc.) is owned by Hub & Spoke — don't
// pull updates from Notion, don't push edits back.
//
// Two entry points:
//   isNotionAuthoritative(postType)        — cheap; use when you have the item
//   isNotionAuthoritativeAccount(account)  — data-driven; use when you have
//                                            the joined account row
//
// Both agree on the seeded data: only the two YouTube accounts are flagged
// synced_from_notion=true, and youtube_long is the only post-type Notion ever
// tracks. If we ever add a non-Notion YouTube channel, the account-scoped
// helper keeps it correct without code changes.

import { normalizePlatform, type PostType } from "@/lib/platform-field-schemas";

/**
 * Accepts either a canonical post_type string (new) or a legacy platform[]
 * array/string (old). Returns true if the item is long-form YouTube — the
 * only content Notion owns today.
 *
 * The array-accepting overload exists so we don't have to touch every call
 * site in one PR; callers that have migrated to reading `item.postType`
 * should pass that directly.
 */
export function isNotionAuthoritative(
  input: PostType | string | string[] | null | undefined
): boolean {
  if (!input) return false;
  if (typeof input === "string") return input === "youtube_long" || normalizePlatform(input) === "youtube_long";
  for (const p of input) {
    if (p === "youtube_long" || normalizePlatform(p) === "youtube_long") return true;
  }
  return false;
}

export function isNotionAuthoritativeAccount(
  account: { syncedFromNotion?: boolean | null } | null | undefined
): boolean {
  return Boolean(account?.syncedFromNotion);
}
