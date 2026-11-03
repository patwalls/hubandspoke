import { isFeatureEnabled } from "@/lib/feature-flags";
import { WHATS_NEW, type WhatsNewEntry } from "./entries";

export type { WhatsNewEntry } from "./entries";

export interface WhatsNewViewer {
  email?: string | null;
  role?: string | null;
  /** `usage_events.screen` values this person opened in the last
   *  `USED_SCREEN_DAYS` days. Undefined = unknown, so no card is held back. */
  openedScreens?: readonly string[];
}

/** How far back "uses this screen" looks. */
export const USED_SCREEN_DAYS = 30;

/**
 * Did this person open one of the card's screens? A `usersOf` entry matches
 * the same screen, the same screen with a query (`/[brand]/content/[id]` ⊃
 * `…?tab=cross-post`), and — when it ends in `/*` — every screen under it
 * (`/[brand]/queue/*` = the queue and each of its tabs).
 */
export function usesAnyScreen(opened: readonly string[], usersOf: readonly string[]): boolean {
  return usersOf.some((want) => {
    const under = want.endsWith("/*") ? want.slice(0, -2) : null;
    const base = under ?? want;
    return opened.some(
      (s) => s === base || s.startsWith(`${base}?`) || (under !== null && s.startsWith(`${under}/`)),
    );
  });
}

/** Is this card worth interrupting this viewer for? (The full list ignores this.) */
function forThisViewer(viewer: WhatsNewViewer, entry: WhatsNewEntry): boolean {
  const usersOf = entry.audience?.usersOf;
  if (!usersOf?.length || viewer.openedScreens === undefined) return true;
  return usesAnyScreen(viewer.openedScreens, usersOf);
}

/** Most cards a returning user is shown at once — older unseen ones stay in the full list. */
export const MAX_POPUP = 5;

/** Every card this viewer is allowed to see, newest first. */
export function visibleTo(
  viewer: WhatsNewViewer,
  entries: WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  return entries.filter((e) => {
    if (e.audience?.adminOnly && viewer.role !== "admin") return false;
    if (e.audience?.flag && !isFeatureEnabled(e.audience.flag, viewer)) return false;
    return true;
  });
}

/**
 * The cards to pop up: visible, shipped after the viewer last dismissed the
 * pop-up — or, if they never have, after their account was created, so a new
 * teammate isn't greeted with months of history — and about a screen they
 * actually use (`audience.usersOf`). 206 pop-ups in two weeks got 6 clicks:
 * most told people about screens they never open.
 */
export function unseenFor(
  viewer: WhatsNewViewer,
  seenAt: Date | null,
  createdAt: Date,
  entries: WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  const since = (seenAt ?? createdAt).getTime();
  return visibleTo(viewer, entries)
    .filter((e) => new Date(e.shippedAt).getTime() > since)
    .filter((e) => forThisViewer(viewer, e))
    .slice(0, MAX_POPUP);
}

/**
 * Hours after a dismissal before the pop-up may open again. Cards that ship
 * in between wait (still unseen) and pop up together on the next visit, so a
 * day with several launches is one interruption, not one per card. The full
 * list stays one click away in the user menu.
 */
export const POPUP_COOLDOWN_HOURS = 20;

/**
 * The cards to pop up on this page load: `unseenFor`, unless the viewer
 * dismissed the pop-up less than `POPUP_COOLDOWN_HOURS` ago.
 */
export function popupFor(
  viewer: WhatsNewViewer,
  seenAt: Date | null,
  createdAt: Date,
  now: Date = new Date(),
  entries: WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  if (seenAt && now.getTime() - seenAt.getTime() < POPUP_COOLDOWN_HOURS * 3_600_000) return [];
  return unseenFor(viewer, seenAt, createdAt, entries);
}

/** Would any card that could pop up now depend on what this viewer opened?
 *  False = skip the usage lookup (the common case: nothing new, or cooldown). */
export function needsOpenedScreens(
  viewer: WhatsNewViewer,
  seenAt: Date | null,
  createdAt: Date,
  now: Date = new Date(),
  entries: WhatsNewEntry[] = WHATS_NEW,
): boolean {
  const unknown = { ...viewer, openedScreens: undefined };
  return popupFor(unknown, seenAt, createdAt, now, entries.filter((e) => e.audience?.usersOf?.length)).length > 0;
}

/** Fill `[brand]` in a card's link with the viewer's brand. */
export function hrefFor(entry: WhatsNewEntry, brand: string): string | undefined {
  return entry.href?.replace("[brand]", brand);
}
