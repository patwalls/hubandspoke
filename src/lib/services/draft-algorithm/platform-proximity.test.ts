import { describe, expect, it } from "vitest";
import {
  getPlatformProximity,
  proximityDirective,
} from "./platform-proximity";

describe("getPlatformProximity", () => {
  describe("same_surface", () => {
    it("treats X ↔ Threads as same_surface in both directions", () => {
      expect(getPlatformProximity("x", "threads")).toBe("same_surface");
      expect(getPlatformProximity("threads", "x")).toBe("same_surface");
    });

    it("treats identical source/target as same_surface", () => {
      // Defensive: a re-cross-post that targets the same platform should
      // never rewrite. Caller probably shouldn't be invoking the agent at
      // all in this case, but if it does, same_surface is the right floor.
      expect(getPlatformProximity("threads", "threads")).toBe("same_surface");
      expect(getPlatformProximity("linkedin", "linkedin")).toBe("same_surface");
    });
  });

  describe("same_family", () => {
    it("treats X ↔ LinkedIn and Threads ↔ LinkedIn as same_family", () => {
      expect(getPlatformProximity("x", "linkedin")).toBe("same_family");
      expect(getPlatformProximity("linkedin", "x")).toBe("same_family");
      expect(getPlatformProximity("threads", "linkedin")).toBe("same_family");
      expect(getPlatformProximity("linkedin", "threads")).toBe("same_family");
    });

    it("treats Instagram post/reel/story and TikTok caption crossings as same_family", () => {
      expect(getPlatformProximity("instagram_post", "instagram_reel")).toBe(
        "same_family",
      );
      expect(getPlatformProximity("instagram_reel", "tiktok")).toBe(
        "same_family",
      );
      expect(getPlatformProximity("instagram_story", "instagram_post")).toBe(
        "same_family",
      );
      expect(getPlatformProximity("tiktok", "instagram_post")).toBe(
        "same_family",
      );
    });
  });

  describe("cross_family", () => {
    it("treats threads → youtube_community as cross_family", () => {
      // This is the failure mode from the original bug report — the
      // empty-body YouTube Community draft. Cross-family is the legacy
      // "pull every concrete element" directive.
      expect(getPlatformProximity("threads", "youtube_community")).toBe(
        "cross_family",
      );
    });

    it("treats text-primary ↔ visual-primary crossings as cross_family", () => {
      expect(getPlatformProximity("x", "instagram_reel")).toBe("cross_family");
      expect(getPlatformProximity("linkedin", "instagram_post")).toBe(
        "cross_family",
      );
      expect(getPlatformProximity("threads", "tiktok")).toBe("cross_family");
    });

    it("treats long-form video and newsletter crossings as cross_family", () => {
      expect(getPlatformProximity("youtube_long", "x")).toBe("cross_family");
      expect(getPlatformProximity("newsletter", "threads")).toBe(
        "cross_family",
      );
      expect(getPlatformProximity("youtube_shorts", "linkedin")).toBe(
        "cross_family",
      );
    });

    it("falls back to cross_family when either side is null/undefined", () => {
      // Defensive: if the caller can't determine the source post type
      // (sourceType !== "cross_post", or substrate.kind === "transcript"),
      // proximity is meaningless and we keep the legacy behavior.
      expect(getPlatformProximity(null, "x")).toBe("cross_family");
      expect(getPlatformProximity("threads", null)).toBe("cross_family");
      expect(getPlatformProximity(undefined, undefined)).toBe("cross_family");
    });
  });
});

describe("proximityDirective", () => {
  it("same_surface directive forbids paraphrasing and reordering", () => {
    const out = proximityDirective("same_surface", "threads", "x");
    expect(out).toContain("same_surface");
    expect(out).toContain("threads");
    expect(out).toContain("x");
    expect(out).toContain("verbatim");
    expect(out).toMatch(/do not paraphrase/i);
    expect(out).toMatch(/do not reorder/i);
  });

  it("same_family directive preserves spine but allows edge edits", () => {
    const out = proximityDirective("same_family", "x", "linkedin");
    expect(out).toContain("same_family");
    expect(out).toMatch(/tighten or expand/i);
    expect(out).toMatch(/do not invent new content/i);
  });

  it("cross_family directive matches the legacy 'pull every concrete element' wording", () => {
    // Keep this assertion strict — the cross_family directive is the
    // legacy behavior and the past-caption exemplars are tuned to it.
    // If we rewrite the wording, we should re-evaluate those exemplars.
    const out = proximityDirective("cross_family", "threads", "youtube_community");
    expect(out).toContain("cross_family");
    expect(out).toContain("EVERY concrete element");
    expect(out).toMatch(/verbatim/i);
  });
});
