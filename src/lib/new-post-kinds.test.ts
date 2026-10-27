import { describe, expect, it } from "vitest";
import { editorForNewPost } from "./new-post-kinds";

const all = { designEditor: true, clipEditor: true };
const none = { designEditor: false, clipEditor: false };

describe("editorForNewPost", () => {
  it("opens an IG post in the design editor only when its format has a template", () => {
    expect(editorForNewPost({ postType: "instagram_post", hasDesignTemplate: true, isXVideoFormat: false, flags: all })).toBe("design");
    expect(editorForNewPost({ postType: "instagram_post", hasDesignTemplate: false, isXVideoFormat: false, flags: all })).toBe("post");
  });

  it("cuts reels and Shorts in the clip editor, with or without a format", () => {
    expect(editorForNewPost({ postType: "instagram_reel", hasDesignTemplate: false, isXVideoFormat: false, flags: all })).toBe("clip");
    expect(editorForNewPost({ postType: "youtube_shorts", hasDesignTemplate: false, isXVideoFormat: false, flags: all })).toBe("clip");
  });

  it("sends X to the clip editor only for a format that posts video", () => {
    expect(editorForNewPost({ postType: "x", hasDesignTemplate: false, isXVideoFormat: true, flags: all })).toBe("clip");
    expect(editorForNewPost({ postType: "x", hasDesignTemplate: false, isXVideoFormat: false, flags: all })).toBe("post");
  });

  it("text posts open the post page, and a missing editor flag falls through to it", () => {
    expect(editorForNewPost({ postType: "linkedin", hasDesignTemplate: true, isXVideoFormat: true, flags: all })).toBe("post");
    expect(editorForNewPost({ postType: "youtube_community", hasDesignTemplate: false, isXVideoFormat: false, flags: all })).toBe("post");
    expect(editorForNewPost({ postType: "instagram_reel", hasDesignTemplate: false, isXVideoFormat: false, flags: none })).toBe("post");
    expect(editorForNewPost({ postType: "instagram_post", hasDesignTemplate: true, isXVideoFormat: false, flags: none })).toBe("post");
  });
});
