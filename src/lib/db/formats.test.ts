import { describe, it, expect } from "vitest";
import { formatNameToSlug, resolveClipAspectRatio } from "./formats";

describe("formatNameToSlug", () => {
  it("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(formatNameToSlug("Repackage Section w/ Hook")).toBe(
      "repackage-section-w-hook",
    );
    expect(formatNameToSlug("X Quotables")).toBe("x-quotables");
  });

  it("collapses runs of separators into a single hyphen", () => {
    expect(formatNameToSlug("Foo -- Bar / Baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing hyphens", () => {
    expect(formatNameToSlug("-Repackage-")).toBe("repackage");
    expect(formatNameToSlug("/X Post/")).toBe("x-post");
  });

  it("two-name slug collision", () => {
    // "X Quotables" and "X-Quotables" slugify identically — the route picks
    // whichever clippable format has the older created_at. Documenting the
    // behavior so a future renamer doesn't accidentally re-collide.
    expect(formatNameToSlug("X Quotables")).toBe("x-quotables");
    expect(formatNameToSlug("X-Quotables")).toBe("x-quotables");
  });
});

describe("resolveClipAspectRatio", () => {
  it("honors an explicit clip_aspect_ratio when set to 9:16", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: "9:16",
        clipTargetPostType: "x", // would default to 16:9, but explicit wins
      }),
    ).toBe("9:16");
  });

  it("honors an explicit clip_aspect_ratio when set to 16:9", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: "16:9",
        clipTargetPostType: "instagram_reel", // would default to 9:16
      }),
    ).toBe("16:9");
  });

  it("derives 9:16 from Reel post type when ratio is null", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: null,
        clipTargetPostType: "instagram_reel",
      }),
    ).toBe("9:16");
  });

  it("derives 9:16 from TikTok post type when ratio is null", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: null,
        clipTargetPostType: "tiktok",
      }),
    ).toBe("9:16");
  });

  it("derives 9:16 from YouTube Shorts post type when ratio is null", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: null,
        clipTargetPostType: "youtube_shorts",
      }),
    ).toBe("9:16");
  });

  it("derives 16:9 from X post type when ratio is null", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: null,
        clipTargetPostType: "x",
      }),
    ).toBe("16:9");
  });

  it("derives 16:9 from YouTube long-form post type when ratio is null", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: null,
        clipTargetPostType: "youtube_long",
      }),
    ).toBe("16:9");
  });

  it("defaults to 9:16 when both fields are null (safest default for Reels-heavy world)", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: null,
        clipTargetPostType: null,
      }),
    ).toBe("9:16");
  });

  it("defaults to 9:16 for unknown post types", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: null,
        clipTargetPostType: "some_future_platform",
      }),
    ).toBe("9:16");
  });

  it("ignores garbage values in clipAspectRatio and falls back to post-type derivation", () => {
    expect(
      resolveClipAspectRatio({
        clipAspectRatio: "1:1",
        clipTargetPostType: "x",
      }),
    ).toBe("16:9");
  });
});
