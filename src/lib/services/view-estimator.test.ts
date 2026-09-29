import { describe, it, expect } from "vitest";
import {
  estimateViewsFromLikes,
  shouldEstimate,
  POST_TYPE_VIEW_MULTIPLIERS,
} from "./view-estimator";

describe("view-estimator", () => {
  it("estimates facebook_post views from reactions at 165x", () => {
    // SC's /facebook/profile/posts returns no view count for any FB post
    // (photo or video), so reactions are the only anchor.
    const { views, estimated } = estimateViewsFromLikes("facebook_post", 51);
    expect(estimated).toBe(true);
    expect(views).toBe(51 * POST_TYPE_VIEW_MULTIPLIERS.facebook_post);
    expect(shouldEstimate("facebook_post")).toBe(true);
  });

  it("does not estimate facebook_post when reactions are absent/zero", () => {
    // ~26% of FB posts land with zero reactions — nothing to multiply, so the
    // row must stay views=null rather than fabricating a 0.
    expect(estimateViewsFromLikes("facebook_post", 0)).toEqual({
      views: null,
      estimated: false,
    });
    expect(estimateViewsFromLikes("facebook_post", null)).toEqual({
      views: null,
      estimated: false,
    });
  });

  it("leaves post types with real view data untouched", () => {
    // tiktok / x / reels get real counts from SC — never estimated.
    for (const pt of ["tiktok", "x", "instagram_reel", "youtube_long"]) {
      expect(shouldEstimate(pt)).toBe(false);
      expect(estimateViewsFromLikes(pt, 100)).toEqual({
        views: null,
        estimated: false,
      });
    }
  });

  it("keeps the existing multiplier family intact", () => {
    expect(POST_TYPE_VIEW_MULTIPLIERS).toMatchObject({
      linkedin: 163,
      threads: 150,
      youtube_community: 194,
      instagram_post: 137,
      facebook_post: 165,
    });
  });
});
