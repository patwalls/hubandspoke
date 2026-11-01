/**
 * Where you were on the Content list when you opened a post (content-list-fast M3).
 *
 * Opening a post and coming back (browser Back, or the post's "← Content" link)
 * used to land at the top of the list: the rows render after the report loads,
 * so the browser's own scroll restore has nothing tall enough to scroll. We
 * remember the row and the scroll offset at the click, and the list puts you
 * back there and flashes the row once.
 *
 * sessionStorage, brand-scoped, one spot per tab. A spot only applies to the
 * same list URL it was saved on (a different filter is a different list) and
 * only for a while — coming back an hour later isn't "coming back".
 */

export interface ReturnSpot {
  /** production_items.id of the row that was opened. */
  id: string;
  /** window.scrollY at the click. */
  y: number;
  /** pathname + search of the list when the row was opened. */
  href: string;
  /** Date.now() at the click. */
  at: number;
}

export const RETURN_SPOT_TTL_MS = 30 * 60 * 1000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const key = (brand: string) => `hubspoke:contentReturn:${brand}`;

export function saveReturnSpot(store: Store, brand: string, spot: ReturnSpot): void {
  try {
    store.setItem(key(brand), JSON.stringify(spot));
  } catch {
    // Private mode / quota — you just land at the top, as before.
  }
}

/**
 * The spot for this list, if there is one — and forget it either way, so it
 * applies to one return only.
 */
export function takeReturnSpot(
  store: Store,
  brand: string,
  href: string,
  now: number,
): ReturnSpot | null {
  let raw: string | null = null;
  try {
    raw = store.getItem(key(brand));
    if (raw !== null) store.removeItem(key(brand));
  } catch {
    return null;
  }
  if (!raw) return null;
  let spot: Partial<ReturnSpot>;
  try {
    spot = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof spot.id !== "string" ||
    typeof spot.y !== "number" ||
    typeof spot.href !== "string" ||
    typeof spot.at !== "number"
  ) {
    return null;
  }
  if (spot.href !== href) return null;
  if (now - spot.at > RETURN_SPOT_TTL_MS || now < spot.at) return null;
  return spot as ReturnSpot;
}

/** A plain left-click that navigates this tab (not cmd/ctrl/shift/middle). */
export function opensInThisTab(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
