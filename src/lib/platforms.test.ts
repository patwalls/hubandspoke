import { describe, it, expect } from "vitest";
import { postTypeDisplay } from "./platforms";

describe("postTypeDisplay", () => {
  it("names a single-type platform by the platform alone", () => {
    expect(postTypeDisplay("tiktok")).toEqual({ platform: "tiktok", label: "TikTok" });
    expect(postTypeDisplay("facebook_post")).toEqual({ platform: "facebook", label: "Facebook" });
    expect(postTypeDisplay("x")).toEqual({ platform: "x", label: "X" });
  });

  it("adds the kind of post where the platform has several", () => {
    // The curator's cross-posts of one post: same title, so this is all that tells them apart.
    expect(postTypeDisplay("youtube_community").label).toBe("YouTube Community");
    expect(postTypeDisplay("instagram_post").label).toBe("Instagram Post");
    expect(postTypeDisplay("instagram_reel")).toEqual({ platform: "instagram", label: "Instagram Reel" });
  });

  it("has no label for a missing or unknown post type", () => {
    expect(postTypeDisplay(null)).toEqual({ platform: "other", label: null });
    expect(postTypeDisplay("")).toEqual({ platform: "other", label: null });
    expect(postTypeDisplay("myspace")).toEqual({ platform: "other", label: null });
  });
});
