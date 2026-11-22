import { leaveRun, type ProductionRun } from "@/lib/production/run";

/**
 * The post the Publish dialog opens after a Ready To Publish post is
 * published (publish-one-trip M3).
 *
 * Publishers post one Ready post after another (146 back-to-back publishes
 * in 14 days, median 3.7 min apart). After each one they went straight back
 * to the In Production list (within a second, before any next card showed)
 * and opened the highlighted next row: 212 next cards shown, 1 opened. So
 * the dialog names the next post up front and Enter goes there.
 *
 * Order, the same one the list highlights:
 *  1. the same post's next cross-post waiting on you (`my-work/next`
 *     siblings): it shares the caption and media just used;
 *  2. the next row of the In Production run, when the post was opened from
 *     the Ready To Publish group;
 *  3. the next post waiting on you, when it is Ready To Publish.
 * Never the post itself, never a post that isn't Ready To Publish.
 */

export const READY = "Ready To Publish";

export interface NextPostBrief {
  id: string;
  title: string | null;
  brand: string;
  status: string | null;
  postType?: string | null;
}

/** What `/api/my-work/next?current=<id>` returns (the parts read here). */
export interface MyWorkNext {
  next: NextPostBrief | null;
  sameSource?: boolean;
  siblings?: NextPostBrief[];
}

export interface PublishNext {
  id: string;
  brand: string;
  title: string;
  postType: string | null;
  /** Why this one: drives the dialog's wording and the usage mark. */
  from: "same-post" | "run" | "my-work";
}

export function nextAfterPublish({
  itemId,
  brand,
  myWork,
  run,
}: {
  itemId: string;
  brand: string;
  myWork: MyWorkNext | null;
  run: ProductionRun | null;
}): PublishNext | null {
  const ready = (r: NextPostBrief | null | undefined): r is NextPostBrief =>
    !!r && r.id !== itemId && r.status === READY;

  const sibling = myWork?.sameSource ? (myWork.siblings ?? []).find(ready) : undefined;
  if (sibling) return brief(sibling, "same-post");

  if (run && run.brand === brand && (run.source ?? "production") === "production" && run.group === READY) {
    const left = leaveRun(run, itemId);
    if (left?.next && left.next.id !== itemId) {
      return { id: left.next.id, brand, title: left.next.title, postType: null, from: "run" };
    }
  }

  if (ready(myWork?.next)) return brief(myWork.next, "my-work");
  return null;
}

function brief(r: NextPostBrief, from: PublishNext["from"]): PublishNext {
  return { id: r.id, brand: r.brand, title: r.title || "Untitled", postType: r.postType ?? null, from };
}

/** The dialog's "Then open next" box, remembered per browser. On unless turned off. */
export const OPEN_NEXT_KEY = "hs:publish-open-next";

export function readOpenNextPref(): boolean {
  try {
    return window.localStorage.getItem(OPEN_NEXT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveOpenNextPref(on: boolean): void {
  try {
    window.localStorage.setItem(OPEN_NEXT_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the box just starts checked next time.
  }
}
