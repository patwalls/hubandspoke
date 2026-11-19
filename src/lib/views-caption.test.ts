import { describe, it, expect } from "vitest";
import { viewsCaption } from "./views-caption";

describe("viewsCaption", () => {
  it("keeps the old labels when there is a number", () => {
    expect(viewsCaption({ postType: "linkedin", views: 1630, viewsEstimated: true, likes: 10, synced: true })).toBe(
      "Estimated from likes",
    );
    expect(viewsCaption({ postType: "x", views: 500, viewsEstimated: false, likes: 3, synced: true })).toBe("Reported");
  });

  it("never says Reported when there is no number (the 0-like LinkedIn/Threads post)", () => {
    for (const likes of [0, null]) {
      const c = viewsCaption({ postType: "threads", views: null, viewsEstimated: false, likes, synced: true });
      expect(c).not.toBe("Reported");
      expect(c).toBe("Threads doesn't report views · estimated once it has likes");
    }
    expect(
      viewsCaption({ postType: "linkedin", views: null, viewsEstimated: false, likes: null, synced: true }),
    ).toBe("LinkedIn doesn't report views · estimated once it has likes");
  });

  it("says the estimate is coming when likes exist but views don't yet", () => {
    expect(
      viewsCaption({ postType: "instagram_post", views: null, viewsEstimated: false, likes: 4, synced: true }),
    ).toBe("Instagram doesn't report views · estimate on next sync");
  });

  it("separates never-synced from not-reported on platforms that report views", () => {
    expect(viewsCaption({ postType: "x", views: null, viewsEstimated: false, likes: null, synced: false })).toBe(
      "Not synced yet",
    );
    expect(viewsCaption({ postType: "tiktok", views: null, viewsEstimated: false, likes: null, synced: true })).toBe(
      "Not reported yet",
    );
  });
});
