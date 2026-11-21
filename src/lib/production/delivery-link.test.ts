import { describe, it, expect } from "vitest";
import { deliveryLabel, linksInComment, liveLinkFromStudio, pickDeliveryLink } from "./delivery-link";

const mention = '<span data-type="mention" data-id="u1" class="mention">@Rita</span>';

describe("deliveryLabel", () => {
  it("names the places editors deliver to", () => {
    expect(deliveryLabel("https://studio.youtube.com/video/abc/edit")).toBe("YouTube Studio");
    expect(deliveryLabel("https://youtu.be/abc")).toBe("YouTube");
    expect(deliveryLabel("https://canva.link/xyz")).toBe("Canva");
    expect(deliveryLabel("https://www.canva.com/design/D/view")).toBe("Canva");
    expect(deliveryLabel("https://typefully.com/?a=1&d=2")).toBe("Typefully");
  });
  it("falls back to the bare host, and refuses non-web links", () => {
    expect(deliveryLabel("https://www.example.org/x")).toBe("example.org");
    expect(deliveryLabel("mailto:a@b.c")).toBeNull();
    expect(deliveryLabel("not a url")).toBeNull();
  });
});

describe("linksInComment", () => {
  it("reads hrefs from the editor's HTML and decodes &amp;", () => {
    const body = `<p>${mention} review &amp; publish. <a href="https://typefully.com/?a=193209&amp;d=11949152" target="_blank">https://typefully.com/?a=193209&amp;d=11949152</a></p>`;
    expect(linksInComment(body)).toEqual(["https://typefully.com/?a=193209&d=11949152"]);
  });
  it("finds bare links in plain-text (synced) comments", () => {
    expect(linksInComment("done: https://canva.link/abc thanks")).toEqual(["https://canva.link/abc"]);
  });
  it("ignores mentions and comments without links", () => {
    expect(linksInComment(`<p>${mention} looks good</p>`)).toEqual([]);
  });
});

describe("pickDeliveryLink", () => {
  const since = new Date("2026-11-15T12:00:00Z");
  const at = (iso: string) => new Date(iso);
  const studio = '<p><a href="https://studio.youtube.com/video/v1/edit">x</a></p>';

  it("takes the link left with the handoff (comment just before the move counts)", () => {
    const link = pickDeliveryLink([{ body: studio, at: at("2026-11-15T11:55:00Z"), by: "Noa" }], since);
    expect(link).toMatchObject({ url: "https://studio.youtube.com/video/v1/edit", label: "YouTube Studio", by: "Noa" });
  });
  it("ignores links from an earlier round (before the post entered Review)", () => {
    expect(pickDeliveryLink([{ body: studio, at: at("2026-11-14T09:00:00Z"), by: "Noa" }], since)).toBeNull();
  });
  it("prefers the newest comment with a link, skipping newer comments without one", () => {
    const link = pickDeliveryLink(
      [
        { body: '<p><a href="https://canva.link/old">v1</a></p>', at: at("2026-11-15T12:10:00Z"), by: "Kay" },
        { body: '<p><a href="https://canva.link/new">v2</a></p>', at: at("2026-11-15T13:00:00Z"), by: "Kay" },
        { body: "<p>thanks!</p>", at: at("2026-11-15T14:00:00Z"), by: "Rita" },
      ],
      since,
    );
    expect(link?.url).toBe("https://canva.link/new");
  });
  it("returns null with no comments", () => {
    expect(pickDeliveryLink([], since)).toBeNull();
  });
});

describe("liveLinkFromStudio", () => {
  it("turns a Studio link into the Short's public link", () => {
    expect(liveLinkFromStudio("https://studio.youtube.com/video/NT-BHHKJ11g/edit", "youtube_shorts")).toBe(
      "https://youtube.com/shorts/NT-BHHKJ11g",
    );
    expect(liveLinkFromStudio(" https://studio.youtube.com/video/6_TYneN_OkQ ", "youtube_shorts")).toBe(
      "https://youtube.com/shorts/6_TYneN_OkQ",
    );
  });
  it("gives long-form videos a watch link", () => {
    expect(liveLinkFromStudio("https://studio.youtube.com/video/Cs0_dFJsikQ/edit", "youtube_long")).toBe(
      "https://www.youtube.com/watch?v=Cs0_dFJsikQ",
    );
  });
  it("offers nothing for other platforms, other hosts or other Studio pages", () => {
    expect(liveLinkFromStudio("https://studio.youtube.com/video/NT-BHHKJ11g/edit", "instagram_reel")).toBeNull();
    expect(liveLinkFromStudio("https://studio.youtube.com/video/NT-BHHKJ11g/edit", "youtube_community")).toBeNull();
    expect(liveLinkFromStudio("https://studio.youtube.com/video/NT-BHHKJ11g/edit", null)).toBeNull();
    expect(liveLinkFromStudio("https://studio.youtube.com/channel/UCabc/videos", "youtube_shorts")).toBeNull();
    expect(liveLinkFromStudio("https://studio.youtube.com/video/short/edit", "youtube_shorts")).toBeNull();
    expect(liveLinkFromStudio("https://www.canva.com/design/D/view", "youtube_shorts")).toBeNull();
    expect(liveLinkFromStudio("not a url", "youtube_shorts")).toBeNull();
  });
});
