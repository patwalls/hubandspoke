/**
 * The posts the next card offered, remembered for the production list.
 *
 * After a Publish (or any send-on) the content page's next card names what
 * is still waiting on you, but the curator goes straight back to the
 * production list by habit (Back within a second, every time) and scans it
 * for the next platform of the same post. So the card's posts are kept in
 * sessionStorage (tab-scoped) and the list marks those rows "Next".
 *
 * Kept for a short while only: a highlight from an hour ago would point at
 * work you have since moved past.
 */
export const NEXT_ROWS_KEY = "hs:next-rows";
export const NEXT_ROWS_MAX_AGE_MS = 30 * 60 * 1000;

interface Stored {
  ids: string[];
  at: number;
}

export function encodeNextRows(ids: string[], now: number): string {
  return JSON.stringify({ ids, at: now } satisfies Stored);
}

/** The remembered ids, or none when missing, malformed or stale. */
export function decodeNextRows(raw: string | null, now: number): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    if (!Array.isArray(v.ids) || typeof v.at !== "number") return [];
    if (now - v.at > NEXT_ROWS_MAX_AGE_MS || now < v.at) return [];
    return v.ids.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function rememberNextRows(ids: string[]): void {
  try {
    window.sessionStorage.setItem(NEXT_ROWS_KEY, encodeNextRows(ids, Date.now()));
  } catch {
    // Private mode / storage full: the list just shows no highlight.
  }
}

export function readNextRows(): string[] {
  try {
    return decodeNextRows(window.sessionStorage.getItem(NEXT_ROWS_KEY), Date.now());
  } catch {
    return [];
  }
}
