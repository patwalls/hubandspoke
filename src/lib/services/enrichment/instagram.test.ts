import { describe, expect, it } from "vitest";
import { carouselSlidesFrom, type IGMedia } from "./instagram";

const carousel: IGMedia = {
  is_video: false,
  edge_sidecar_to_children: {
    edges: [
      { node: { is_video: false, display_url: "https://cdn/a.jpg" } },
      { node: { is_video: false, display_url: "https://cdn/b.jpg" } },
      { node: { is_video: true, display_url: "https://cdn/c-poster.jpg", video_url: "https://cdn/c.mp4" } },
      { node: { is_video: true, display_url: "https://cdn/d-poster.jpg", video_url: "https://cdn/d.mp4" } },
    ],
  },
};

describe("carouselSlidesFrom", () => {
  it("archives every carousel slide — images and videos — on the 1-credit call", () => {
    // Regression: gating this on withMedia left our own PLAYBOOK carousels
    // with a poster and zero slides.
    const slides = carouselSlidesFrom(carousel, undefined, "abc", { withMedia: false });
    expect(slides.map((s) => s.kind)).toEqual(["image", "image", "video", "video"]);
    expect(slides[2]).toMatchObject({ url: "https://cdn/c.mp4", posterUrl: "https://cdn/c-poster.jpg" });
  });

  it("ignores SC's flat list for carousels (it only lists the videos)", () => {
    const slides = carouselSlidesFrom(
      carousel,
      [{ cdn_url: "https://sc/c.mp4", type: "video" }],
      "abc",
      { withMedia: true }
    );
    expect(slides).toHaveLength(4);
    expect(slides[0].url).toBe("https://cdn/a.jpg");
  });

  it("single-media posts still need withMedia for the paid download list", () => {
    const single: IGMedia = { is_video: true, display_url: "https://cdn/p.jpg" };
    const urls = [{ cdn_url: "https://sc/reel.mp4", type: "video" }];
    expect(carouselSlidesFrom(single, urls, "r", { withMedia: false })).toEqual([]);
    expect(carouselSlidesFrom(single, urls, "r", { withMedia: true })).toEqual([
      { url: "https://sc/reel.mp4", kind: "video", fileNameHint: "r" },
    ]);
  });

  it("skips sidecar nodes with no usable url", () => {
    const m: IGMedia = {
      edge_sidecar_to_children: { edges: [{ node: { is_video: true } }, {}, { node: { display_url: "https://cdn/x.jpg" } }] },
    };
    expect(carouselSlidesFrom(m, undefined, "s", { withMedia: false })).toHaveLength(1);
  });
});
