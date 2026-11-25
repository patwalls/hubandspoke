import { describe, expect, it } from "vitest";
import { BOUNCE_WINDOW_MS, PICK_WINDOW_MS, onListOpened, onPostOpened, type Landed } from "./open-next-trail";

const T = 1_000_000;
const landed: Landed = { id: "b", from: "same-post", at: T };

describe("open-next trail", () => {
  it("the landing page itself keeps the trail", () => {
    expect(onPostOpened(landed, "b", T + 500)).toEqual({ mark: null, keep: landed });
  });

  it("back on the list within 30 s is a bounce, counted once", () => {
    const step = onListOpened(landed, T + 3_000);
    expect(step.mark).toBe("publish:open-next:back-to-list");
    expect(step.keep).toEqual({ ...landed, backAt: T + 3_000 });
    // The list refetching or re-rendering doesn't count it again.
    expect(onListOpened(step.keep, T + 4_000)).toEqual({ mark: null, keep: step.keep });
  });

  it("reopening the landed post after the bounce says the list is home base", () => {
    const back = onListOpened(landed, T + 3_000).keep;
    expect(onPostOpened(back, "b", T + 8_000)).toEqual({ mark: "publish:open-next:reopened-same", keep: null });
  });

  it("opening another post after the bounce says open-next picked the wrong one", () => {
    const back = onListOpened(landed, T + 3_000).keep;
    expect(onPostOpened(back, "c", T + 8_000)).toEqual({ mark: "publish:open-next:picked-other", keep: null });
  });

  it("a late return to the list is a new errand, not a bounce", () => {
    expect(onListOpened(landed, T + BOUNCE_WINDOW_MS + 1)).toEqual({ mark: null, keep: null });
  });

  it("a post opened long after the bounce isn't its pick", () => {
    const back = onListOpened(landed, T + 3_000).keep;
    expect(onPostOpened(back, "b", T + 3_000 + PICK_WINDOW_MS + 1)).toEqual({ mark: null, keep: null });
  });

  it("stepping from the landing to another post without the list drops the trail", () => {
    expect(onPostOpened(landed, "c", T + 5_000)).toEqual({ mark: null, keep: null });
  });

  it("nothing remembered, nothing marked", () => {
    expect(onListOpened(null, T)).toEqual({ mark: null, keep: null });
    expect(onPostOpened(null, "b", T)).toEqual({ mark: null, keep: null });
  });
});
