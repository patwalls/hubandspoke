// What the Attach-DM-keyword dialog prefills in its Destination field.
// Pure + client-safe so the rules are unit-tested (dm-destination-prefill.test.ts).

/** A destination the smart suggestion may replace: empty, or the bare Starter
 *  Story homepage the field defaults to. */
export function isDefaultDestination(value: string): boolean {
  const v = value.trim().replace(/\/$/, "");
  return v === "" || v === "https://www.starterstory.com" || v === "https://starterstory.com";
}

export function isGoLink(value: string): boolean {
  try {
    return new URL(value.trim()).hostname.toLowerCase() === "go.starterstory.com";
  } catch {
    return false;
  }
}

/**
 * The field's starting value, given a link's saved destination and this post's
 * suggested page (null while loading / on failure).
 *
 * A Starter Story keyword's saved destination is a go.starterstory.com per-post
 * link (keyword → per-post link → page), never the page itself. Carrying it over
 * would chain this post onto ANOTHER post's link (DM clicks land there and leads
 * are credited to it) or onto its own (a redirect loop). So a go link is never
 * prefilled — the suggestion, else empty (the late suggestion fills an empty
 * field). Anything else hand-entered is kept.
 */
export function prefillDestination(saved: string, suggestion: string | null): string {
  if (isGoLink(saved)) return suggestion ?? "";
  return isDefaultDestination(saved) && suggestion ? suggestion : saved;
}
