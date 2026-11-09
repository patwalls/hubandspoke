import { describe, it, expect } from "vitest";
import {
  shareLinkWarning,
  validatePublishedLinkPlatform,
} from "./published-link-validation";

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

describe("shareLinkWarning", () => {
  // The shape a curator pasted 32 times in 21 days; none of those posts
  // ever got views (2026-11).
  it("warns on a Facebook share link", () => {
    expect(
      shareLinkWarning("https://www.facebook.com/share/p/14utCXSMshb/"),
    ).toMatch(/facebook share link/i);
    expect(shareLinkWarning("https://m.facebook.com/share/r/abc/")).toMatch(
      /won't bring back views/,
    );
  });

  it("warns on Facebook and LinkedIn short links", () => {
    expect(shareLinkWarning("https://fb.watch/abc123/")).toMatch(/facebook/i);
    expect(shareLinkWarning("https://lnkd.in/gXyz")).toMatch(/linkedin/i);
  });

  it("stays quiet on a post's own link", () => {
    expect(
      shareLinkWarning("https://www.facebook.com/reel/1031748306549885/"),
    ).toBeNull();
    expect(
      shareLinkWarning(
        "https://www.facebook.com/starterstoryofficial/posts/pfbid022Sk",
      ),
    ).toBeNull();
    expect(
      shareLinkWarning("https://www.linkedin.com/feed/update/urn:li:share:1/"),
    ).toBeNull();
    // A page literally named "share…" isn't the share redirect.
    expect(shareLinkWarning("https://www.facebook.com/sharegroup/posts/1")).toBeNull();
  });

  it("stays quiet on half-typed or empty input", () => {
    expect(shareLinkWarning("")).toBeNull();
    expect(shareLinkWarning("facebook.com/share/p/x")).toBeNull();
    expect(shareLinkWarning(null)).toBeNull();
  });
});
