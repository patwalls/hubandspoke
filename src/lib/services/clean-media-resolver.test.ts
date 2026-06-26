import { describe, it, expect } from "vitest";
import { classifyMediaSource } from "./clean-media-resolver";

describe("classifyMediaSource", () => {
  it("treats a null sourceUrl as a manual upload (clean)", () => {
    expect(classifyMediaSource(null)).toBe("manual");
    expect(classifyMediaSource(undefined)).toBe("manual");
    expect(classifyMediaSource("")).toBe("manual");
  });

  it("recognizes Descript exports as clean", () => {
    expect(
      classifyMediaSource(
        "https://production-273614-media-export.storage.googleapis.com/abc/clip.mp4",
      ),
    ).toBe("descript");
  });

  it("flags TikTok CDN downloads as dirty (watermark risk)", () => {
    expect(
      classifyMediaSource("https://v16-webapp.tiktokcdn-us.com/xyz/video.mp4"),
    ).toBe("tiktok_dirty");
    expect(
      classifyMediaSource("https://www.tiktok.com/@x/video/123"),
    ).toBe("tiktok_dirty");
    expect(classifyMediaSource("https://p16.musical.ly/foo")).toBe(
      "tiktok_dirty",
    );
  });

  it("treats non-TikTok platform downloads as clean-enough", () => {
    expect(
      classifyMediaSource(
        "https://scontent-lga3-3.cdninstagram.com/v/t51/video.mp4",
      ),
    ).toBe("platform_clean");
    expect(
      classifyMediaSource("https://rr3---sn-yt.googlevideo.com/videoplayback"),
    ).toBe("platform_clean");
  });
});
