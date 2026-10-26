import { describe, expect, it } from "vitest";
import { beehiivEditUrl, beehiivPreviewUrl, beehiivPreviewUrlFromEditUrl } from "./beehiiv-links";

const id = "f1323c90-a241-4c83-8ac6-7678fc656895";

describe("beehiiv links", () => {
  it("editor link drops the post_ prefix, preview link keeps it (as the API's preview_url does)", () => {
    expect(beehiivEditUrl(`post_${id}`)).toBe(`https://app.beehiiv.com/posts/${id}/edit`);
    expect(beehiivPreviewUrl(`post_${id}`)).toBe(`https://app.beehiiv.com/posts/post_${id}/preview`);
    expect(beehiivPreviewUrl(id)).toBe(`https://app.beehiiv.com/posts/post_${id}/preview`);
  });

  it("derives the preview link from the saved editor link only", () => {
    expect(beehiivPreviewUrlFromEditUrl(beehiivEditUrl(`post_${id}`))).toBe(beehiivPreviewUrl(id));
    expect(beehiivPreviewUrlFromEditUrl(`https://app.beehiiv.com/posts/post_${id}/edit`)).toBe(beehiivPreviewUrl(id));
    expect(beehiivPreviewUrlFromEditUrl("https://app.hubspot.com/email/1/edit/2")).toBeNull();
    expect(beehiivPreviewUrlFromEditUrl(null)).toBeNull();
  });
});
