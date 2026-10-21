// The dashboard "Channels" filter travels as a single URL/query string:
// "all" for no filter, otherwise a comma-separated list of channel keys.
// A channel is one (account, post type) pair, keyed `<accountId>|<postType>`
// (`<accountId>|` when the platform has no post types) — the same key shape
// the format page's Accounts picker uses.

export interface ChannelKey {
  accountId: string;
  postType: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function channelKey(c: ChannelKey): string {
  return `${c.accountId}|${c.postType ?? ""}`;
}

/** Parse a channels filter value, or `null` for "no filter". Malformed
 *  entries (non-UUID account ids) are dropped so a hand-edited URL can't
 *  500 the uuid column comparison. */
export function parseChannelFilter(value: string | null | undefined): ChannelKey[] | null {
  if (!value || value === "all") return null;
  const seen = new Set<string>();
  const out: ChannelKey[] = [];
  for (const raw of value.split(",")) {
    const [accountId = "", postType = ""] = raw.trim().split("|");
    if (!UUID_RE.test(accountId)) continue;
    const c = { accountId, postType: postType || null };
    const k = channelKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out.length ? out : null;
}

/** Serialize selected channel keys. Empty, or every option picked,
 *  collapses to "all". */
export function serializeChannelFilter(keys: string[], allOptions: string[]): string {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return "all";
  if (allOptions.length > 0 && allOptions.every((o) => unique.includes(o))) return "all";
  return unique.join(",");
}
