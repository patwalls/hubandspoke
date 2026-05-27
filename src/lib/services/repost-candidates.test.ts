import { describe, expect, it } from "vitest";
import { isOriginalRepostBlocked } from "./repost-candidates";

// You don't re-upload a long-form YouTube video the way you re-share a banger
// tweet or reel, so original YouTube content is barred from the repost queue —
// but YouTube clips / cross-posts (Shorts repurposed from a pillar) are not.
describe("isOriginalRepostBlocked", () => {
  it("blocks original content on YouTube", () => {
    expect(isOriginalRepostBlocked("youtube", "original")).toBe(true);
  });

  it("keeps YouTube clips and cross-posts eligible", () => {
    expect(isOriginalRepostBlocked("youtube", "repurposed")).toBe(false);
    expect(isOriginalRepostBlocked("youtube", "cross_post")).toBe(false);
  });

  it("never blocks originals on other platforms", () => {
    // Reposting a hit tweet / reel is a legitimate evergreen strategy.
    for (const platform of ["x", "instagram", "tiktok", "linkedin", "threads"]) {
      expect(isOriginalRepostBlocked(platform, "original")).toBe(false);
    }
  });

  it("does not block when platform is unknown", () => {
    expect(isOriginalRepostBlocked(null, "original")).toBe(false);
  });
});
