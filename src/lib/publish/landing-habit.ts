/**
 * Where "Then open next" takes you after a Publish, learned per browser
 * (publish-one-trip M7).
 *
 * The Publish dialog opens the next Ready post (M3). Some publishers use
 * that post; others work from the In Production list and click back to it
 * a second after every landing, then open the same post again from there
 * (M5's marks: back-to-list on every landing, then reopened-same). For them
 * the landing is a detour.
 *
 * So this browser counts quick returns: a landing followed by a trip back to
 * the list within 30 s is a bounce, and a landing that isn't is a stay. After
 * BOUNCES_TO_LEARN bounces in a row, "Then open next" goes to the list with
 * the next post's row marked "Next" and under the keyboard cursor (Enter
 * opens it). The dialog says so, with a way back to opening the post.
 *
 * localStorage, so it holds across tabs and days. Everyone else (anyone who
 * stays on the post they land on) keeps the old behavior.
 */

export const HABIT_KEY = "hs:publish-open-next-habit";
export const BOUNCES_TO_LEARN = 2;

export interface Habit {
  /** Bounces in a row since the last stay (or reset). */
  bounces: number;
  /** A landing has happened and its outcome isn't known yet. */
  pending: boolean;
  /** Set when the person chose "open the post" in the dialog: never learn again. */
  optedOut?: boolean;
}

export const EMPTY_HABIT: Habit = { bounces: 0, pending: false };

/** The dialog sent them to a post. A previous landing still pending was a stay. */
export function onLanding(h: Habit): Habit {
  return { ...h, bounces: h.pending ? 0 : h.bounces, pending: true };
}

/** They were back on the list within the bounce window of a landing. */
export function onBounce(h: Habit): Habit {
  if (!h.pending) return h;
  return { ...h, bounces: h.bounces + 1, pending: false };
}

/** Send them to the list instead of the post. */
export function prefersList(h: Habit): boolean {
  return !h.optedOut && h.bounces >= BOUNCES_TO_LEARN;
}

/** "Open the post instead": back to the old behavior for good. */
export function optOut(): Habit {
  return { bounces: 0, pending: false, optedOut: true };
}

export function decodeHabit(raw: string | null): Habit {
  if (!raw) return EMPTY_HABIT;
  try {
    const v = JSON.parse(raw) as Partial<Habit>;
    const bounces = typeof v.bounces === "number" && v.bounces >= 0 ? Math.floor(v.bounces) : 0;
    return { bounces, pending: v.pending === true, ...(v.optedOut === true ? { optedOut: true } : {}) };
  } catch {
    return EMPTY_HABIT;
  }
}

export function readHabit(): Habit {
  try {
    return decodeHabit(window.localStorage.getItem(HABIT_KEY));
  } catch {
    return EMPTY_HABIT;
  }
}

export function saveHabit(h: Habit): void {
  try {
    window.localStorage.setItem(HABIT_KEY, JSON.stringify(h));
  } catch {
    // Private mode: the dialog keeps opening the post.
  }
}

/**
 * The In Production list to land on: the filtered list this tab last had
 * open for that brand (BackLink's memory), else the bare list.
 */
export function listHref(brand: string, remembered: string | null): string {
  if (remembered && remembered.startsWith(`/${brand}/production`) && !remembered.startsWith("//")) {
    return remembered;
  }
  return `/${brand}/production`;
}

export function rememberedProductionList(brand: string): string | null {
  try {
    return window.sessionStorage.getItem(`hubspoke:lastList:${brand}:production`);
  } catch {
    return null;
  }
}
