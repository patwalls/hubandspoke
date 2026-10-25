import { describe, it, expect } from "vitest";
import { validatePublishedLinkPlatform } from "./published-link-validation";

describe("validatePublishedLinkPlatform", () => {
  // The two shapes that reached prod through the content page's Publish
  // dialog before its route checked the platform (2026-10).
  it("refuses a TikTok link on an Instagram Reel", () => {
    expect(
      validatePublishedLinkPlatform(
        "https://www.tiktok.com/@starterstory/video/1",
        "instagram_reel",
      ),
    ).toMatch(/tiktok/i);
  });

  it("refuses a TikTok link on a YouTube Short", () => {
    expect(
      validatePublishedLinkPlatform(
        "https://www.tiktok.com/@starterstory/video/1",
        "youtube_shorts",
      ),
    ).toMatch(/tiktok/i);
  });

  it("accepts a link from the post's own platform", () => {
    expect(
      validatePublishedLinkPlatform(
        "https://www.instagram.com/reel/abc/",
        "instagram_reel",
      ),
    ).toBeNull();
  });

  it("lets through links it can't place (newsletters, no post type)", () => {
    expect(
      validatePublishedLinkPlatform("https://newsletter.futurepedia.io/p/x", "newsletter"),
    ).toBeNull();
    expect(validatePublishedLinkPlatform("https://x.com/a/status/1", null)).toBeNull();
  });
});
