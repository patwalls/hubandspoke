import { describe, it, expect } from "vitest";
import { resolveAutoPostType } from "./infer-post-type";

describe("resolveAutoPostType", () => {
  it("never overrides an existing post type, even when the URL implies another", () => {
    // Regression: a YouTube Short synced with a watch?v= link was getting
    // auto-rewritten to youtube_long every time someone opened the page.
    expect(
      resolveAutoPostType({
        currentPostType: "youtube_shorts",
        publishedLink: "https://www.youtube.com/watch?v=abc123",
        accountPlatform: "youtube",
      })
    ).toBeNull();
  });

  it("fills in a missing post type from the URL", () => {
    expect(
      resolveAutoPostType({
        currentPostType: null,
        publishedLink: "https://www.youtube.com/shorts/abc123",
        accountPlatform: "youtube",
      })
    ).toBe("youtube_shorts");
    expect(
      resolveAutoPostType({
        currentPostType: null,
        publishedLink: "https://www.youtube.com/watch?v=abc123",
        accountPlatform: "youtube",
      })
    ).toBe("youtube_long");
  });

  it("ignores URLs whose platform doesn't match the selected account", () => {
    expect(
      resolveAutoPostType({
        currentPostType: null,
        publishedLink: "https://www.instagram.com/reel/abc123/",
        accountPlatform: "youtube",
      })
    ).toBeNull();
  });

  it("returns null with no link or an unparseable link", () => {
    expect(
      resolveAutoPostType({
        currentPostType: null,
        publishedLink: null,
        accountPlatform: "youtube",
      })
    ).toBeNull();
    expect(
      resolveAutoPostType({
        currentPostType: null,
        publishedLink: "not a url",
        accountPlatform: "youtube",
      })
    ).toBeNull();
  });
});
