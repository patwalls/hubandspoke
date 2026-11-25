import type { PublishNext } from "./next-after-publish";

/**
 * What happens after the Publish dialog opens the next post (publish-one-trip
 * M5, a measurement).
 *
 * After "Then open next" lands the curator on the next Ready post, most
 * landings are followed within seconds by a trip back to the In Production
 * list and another post opened from it. Two readings call for opposite
 * fixes:
 *  - they reopen the post they had just landed on (the list is home base,
 *    the landing saved nothing): send them to the list instead;
 *  - they pick a different post (open-next chose the wrong platform /
 *    order): make open-next follow the order they publish in.
 *
 * So the landing is remembered (tab-scoped), the list notes a quick return,
 * and the next post opened says which reading it was. Marks:
 *   publish:open-next:back-to-list   back on the list within 30 s of landing
 *   publish:open-next:reopened-same  then opened the post it had landed on
 *   publish:open-next:picked-other   then opened a different post
 */

export const LANDED_KEY = "hs:publish-open-next-landed";
/** A return to the list later than this is a new errand, not a bounce. */
export const BOUNCE_WINDOW_MS = 30_000;
/** How long after the bounce the next post opened still counts as its pick. */
export const PICK_WINDOW_MS = 120_000;

export interface Landed {
  id: string;
  from: PublishNext["from"];
  at: number;
  /** When the list was opened after the landing (a bounce). */
  backAt?: number;
}

export type TrailMark =
  | "publish:open-next:back-to-list"
  | "publish:open-next:reopened-same"
  | "publish:open-next:picked-other";

export interface TrailStep {
  mark: TrailMark | null;
  /** What to keep in storage; null clears it. */
  keep: Landed | null;
}

/** The In Production list was opened. */
export function onListOpened(landed: Landed | null, now: number): TrailStep {
  if (!landed) return { mark: null, keep: null };
  // Already bounced (the list re-rendered or refetched): count it once.
  if (landed.backAt !== undefined) return { mark: null, keep: landed };
  if (now - landed.at > BOUNCE_WINDOW_MS) return { mark: null, keep: null };
  return { mark: "publish:open-next:back-to-list", keep: { ...landed, backAt: now } };
}

/** A post page was opened. */
export function onPostOpened(landed: Landed | null, postId: string, now: number): TrailStep {
  if (!landed) return { mark: null, keep: null };
  if (landed.backAt === undefined) {
    // The landing itself (or a reload of it) keeps the trail; stepping to
    // another post without the list is neither reading.
    return postId === landed.id && now - landed.at <= BOUNCE_WINDOW_MS
      ? { mark: null, keep: landed }
      : { mark: null, keep: null };
  }
  if (now - landed.backAt > PICK_WINDOW_MS) return { mark: null, keep: null };
  return {
    mark: postId === landed.id ? "publish:open-next:reopened-same" : "publish:open-next:picked-other",
    keep: null,
  };
}

export function readLanded(): Landed | null {
  try {
    const raw = window.sessionStorage.getItem(LANDED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Landed;
    return v && typeof v.id === "string" && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}

export function writeLanded(v: Landed | null): void {
  try {
    if (v) window.sessionStorage.setItem(LANDED_KEY, JSON.stringify(v));
    else window.sessionStorage.removeItem(LANDED_KEY);
  } catch {
    // Private mode: the marks just don't fire.
  }
}

/** Apply a step: store what it keeps and return its mark. */
export function applyTrail(step: TrailStep): TrailMark | null {
  writeLanded(step.keep);
  return step.mark;
}
