/**
 * Turn a dashboard URL into the screen name `usage_events` stores.
 *
 * Names are route PATTERNS, never raw URLs: ids collapse to `[id]`, the brand
 * slug to `[brand]` (kept separately in `brand`), and only an allowlisted
 * query param or two survive. That keeps the table groupable ("how often is
 * the clips queue opened?") and keeps content ids and search text out of it.
 */

// First path segments that are real top-level routes, not a brand slug.
// `all` is deliberately absent — it's the synthetic "All content" brand.
const TOP_LEVEL = new Set(["admin", "coverage", "developers", "my-work", "notifications", "settings"]);

// Query params that change what the screen shows (a tab, a view mode).
const KEPT_PARAMS = ["tab", "v"];

// Params `useDialogUrl` sets while a triage modal is open — kept as `[id]`
// so "opened the clip modal on the queue" is countable without the id.
const DIALOG_PARAMS = ["item", "clip", "candidate"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /^[a-z][a-z0-9_-]{0,29}$/i;

export interface Screen {
  screen: string;
  brand: string | null;
}

export function screenFor(pathname: string, search = ""): Screen {
  const parts = pathname.split("/").filter(Boolean);
  let brand: string | null = null;
  if (parts.length > 0 && !TOP_LEVEL.has(parts[0])) {
    brand = WORD.test(parts[0]) ? parts[0] : null;
    parts[0] = "[brand]";
  }
  const out = parts.map((seg, i) => {
    if (i === 0 && seg === "[brand]") return seg;
    const parent = parts[i - 1];
    if (i > 0 && (parent === "content" || parent === "formats")) return "[id]";
    if (parent === "brands" && parts[i - 2] === "settings") return "[brand]";
    if (UUID.test(seg) || /^\d+$/.test(seg) || !WORD.test(seg)) return "[id]";
    return seg;
  });

  const params = new URLSearchParams(search);
  const kept = KEPT_PARAMS.flatMap((k) => {
    const v = params.get(k);
    return v && WORD.test(v) ? [`${k}=${v}`] : [];
  });
  for (const k of DIALOG_PARAMS) if (params.get(k)) kept.push(`${k}=[id]`);

  const path = "/" + out.join("/");
  return { screen: kept.length ? `${path}?${kept.join("&")}` : path, brand };
}

/** A non-route mark (`modal:clip-editor`, `whats-new:click:<id>`) — same shape rules. */
export function isValidMark(mark: string): boolean {
  return /^[a-z][a-z0-9:_./?=&[\]-]{0,119}$/i.test(mark);
}
