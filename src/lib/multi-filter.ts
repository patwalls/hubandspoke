// Multi-select dashboard filters (Platform, Account, Post type, Channels,
// Format, Source) travel as a single URL/query string each:
//   "all"          no filter
//   "a,b"          only a and b                    (include mode)
//   "!a,b"         everything except a and b       (exclude mode)
// The serializer picks whichever list is shorter, so unticking one channel
// out of hundreds stays a short URL (Heroku's router caps the request line
// at 8 KB), and "all except YouTube long form" keeps covering channels added
// later. Items escape only `%`, `,` and a leading `!`, so values containing
// a comma (e.g. a format name) survive. A bare single value is a one-item
// include list, so old links like `?postType=youtube_long` keep working.
//
// A channel is one (account, post type) pair, keyed `<accountId>|<postType>`
// (`<accountId>|` when the platform has no post types) — the same key shape
// the format page's Accounts picker uses.

export interface MultiFilter {
  mode: "include" | "exclude";
  items: string[];
}

export interface ChannelKey {
  accountId: string;
  postType: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function encodeItem(v: string): string {
  return v.replace(/%/g, "%25").replace(/,/g, "%2C").replace(/^!/, "%21");
}

function decodeItem(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Parse a filter value, or `null` for "no filter". */
export function parseMultiFilter(value: string | null | undefined): MultiFilter | null {
  if (!value || value === "all") return null;
  const mode = value.startsWith("!") ? "exclude" : "include";
  const body = mode === "exclude" ? value.slice(1) : value;
  const items = [
    ...new Set(body.split(",").map((v) => decodeItem(v.trim())).filter(Boolean)),
  ];
  return items.length ? { mode, items } : null;
}

/** Does `item` pass the filter? (`null` filter passes everything.) */
export function multiFilterAllows(f: MultiFilter | null, item: string): boolean {
  if (!f) return true;
  return f.mode === "include" ? f.items.includes(item) : !f.items.includes(item);
}

/** Serialize the selected items out of `allOptions`. Empty or full
 *  selections collapse to "all"; otherwise whichever of the include /
 *  exclude lists is shorter wins. */
export function serializeMultiFilter(selected: string[], allOptions: string[]): string {
  const picked = new Set(selected);
  const included = allOptions.filter((o) => picked.has(o));
  const excluded = allOptions.filter((o) => !picked.has(o));
  if (included.length === 0 || excluded.length === 0) return "all";
  return excluded.length < included.length
    ? "!" + excluded.map(encodeItem).join(",")
    : included.map(encodeItem).join(",");
}

/** Like parseMultiFilter, keeping only well-formed account UUIDs so a
 *  hand-edited URL can't 500 the uuid column comparison. */
export function parseAccountFilter(value: string | null | undefined): MultiFilter | null {
  const f = parseMultiFilter(value);
  if (!f) return null;
  const items = f.items.filter(isUuid);
  return items.length ? { ...f, items } : null;
}

export function channelKey(c: ChannelKey): string {
  return `${c.accountId}|${c.postType ?? ""}`;
}

/** Parse a channels filter value, or `null` for "no filter". Malformed
 *  entries (non-UUID account ids) are dropped. */
export function parseChannelFilter(
  value: string | null | undefined
): { mode: MultiFilter["mode"]; channels: ChannelKey[] } | null {
  const f = parseMultiFilter(value);
  if (!f) return null;
  const channels: ChannelKey[] = [];
  for (const raw of f.items) {
    const [accountId = "", postType = ""] = raw.split("|");
    if (!isUuid(accountId)) continue;
    channels.push({ accountId, postType: postType || null });
  }
  return channels.length ? { mode: f.mode, channels } : null;
}
