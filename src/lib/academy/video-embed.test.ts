import { describe, expect, it } from "vitest";
import { embedUrlAt, timestampSeconds, videoEmbedUrl } from "./video-embed";
import { slugify } from "./validate";

describe("videoEmbedUrl", () => {
  it.each([
    ["https://www.loom.com/share/0c064494304c4b64a73138040e60638a", "https://www.loom.com/embed/0c064494304c4b64a73138040e60638a"],
    ["https://www.loom.com/share/36c10f47?focus_title=1&muted=1", "https://www.loom.com/embed/36c10f47"],
    ["https://www.youtube.com/watch?v=abc123XYZ_-", "https://www.youtube.com/embed/abc123XYZ_-"],
    ["https://youtu.be/abc123", "https://www.youtube.com/embed/abc123"],
    ["https://www.youtube.com/shorts/abc123", "https://www.youtube.com/embed/abc123"],
    ["https://vimeo.com/123456", "https://player.vimeo.com/video/123456"],
    ["https://drive.google.com/file/d/1AbC-dEf/view?usp=sharing", "https://drive.google.com/file/d/1AbC-dEf/preview"],
  ])("embeds %s", (input, expected) => {
    expect(videoEmbedUrl(input)).toBe(expected);
  });

  it("returns null for non-video links and junk", () => {
    expect(videoEmbedUrl("https://example.com/video")).toBeNull();
    expect(videoEmbedUrl("not a url")).toBeNull();
    expect(videoEmbedUrl(null)).toBeNull();
  });
});

describe("timestamps", () => {
  it("parses m:ss and h:mm:ss", () => {
    expect(timestampSeconds("1:09")).toBe(69);
    expect(timestampSeconds("1:02:03")).toBe(3723);
    expect(timestampSeconds("soon")).toBeNull();
  });

  it("builds a start-at URL per provider", () => {
    expect(embedUrlAt("https://www.loom.com/embed/x", 69)).toBe("https://www.loom.com/embed/x?t=69&autoplay=1");
    expect(embedUrlAt("https://www.youtube.com/embed/x", 69)).toBe("https://www.youtube.com/embed/x?start=69&autoplay=1");
    expect(embedUrlAt("https://player.vimeo.com/video/1", 69)).toBe("https://player.vimeo.com/video/1#t=69s");
  });
});

describe("slugify", () => {
  it("makes URL-safe slugs", () => {
    expect(slugify("Set Up Your Brand & Accounts")).toBe("set-up-your-brand-accounts");
    expect(slugify("Hub & Spoke: Overview & Tour (watch this first)")).toBe("hub-spoke-overview-tour-watch-this-first");
    expect(slugify("!!!")).toBe("video");
  });
});
