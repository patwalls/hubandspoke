import { describe, expect, it } from "vitest";
import { assertAllowedHubspotCall, buildWidgets } from "./hubspot-marketing-email";

describe("buildWidgets", () => {
  const email = {
    id: "9",
    content: {
      widgets: {
        masthead: { body: { path: "@hubspot/image_email" } },
        intro: { body: { path: "@hubspot/rich_text", html: "<p>old</p>", css_class: "x" } },
        label: { body: { label_text: "The Orange Juice 🍊" } },
        preview_text: { body: { value: "old preview" } },
      },
    },
  };

  it("fills the mapped rich-text blocks and preview text, and sends every other widget unchanged", () => {
    const out = buildWidgets(email, { intro: "<p>new</p>" }, "Starter Story Sunday Breakfast");
    expect(out.intro).toEqual({ body: { path: "@hubspot/rich_text", html: "<p>new</p>", css_class: "x" } });
    expect(out.preview_text.body?.value).toBe("Starter Story Sunday Breakfast");
    expect(out.masthead).toEqual(email.content.widgets.masthead);
    expect(out.label).toEqual(email.content.widgets.label);
    expect(Object.keys(out)).toHaveLength(4);
  });

  it("fails loudly on a stale mapping: a missing block, or one that isn't rich text", () => {
    expect(() => buildWidgets(email, { gone: "<p>x</p>" }, null)).toThrow(/has no block gone/);
    expect(() => buildWidgets(email, { label: "<p>x</p>" }, null)).toThrow(/isn't a rich-text block/);
  });
});

describe("assertAllowedHubspotCall", () => {
  it("allows only reading, cloning and editing marketing emails", () => {
    expect(() => assertAllowedHubspotCall("GET", "/marketing/v3/emails/123")).not.toThrow();
    expect(() => assertAllowedHubspotCall("post", "/marketing/v3/emails/clone")).not.toThrow();
    expect(() => assertAllowedHubspotCall("PATCH", "/marketing/v3/emails/123")).not.toThrow();
  });

  it("blocks sending, publishing, deleting and anything outside marketing emails", () => {
    for (const [method, path] of [
      ["POST", "/marketing/v3/emails/123/publish"],
      ["POST", "/marketing/v3/emails/123/unpublish"],
      ["POST", "/marketing/v3/transactional/single-email/send"],
      ["DELETE", "/marketing/v3/emails/123"],
      ["GET", "/crm/v3/objects/contacts"],
      ["GET", "/marketing/v3/emails"],
      ["PATCH", "/marketing/v3/emails/123/draft"],
      ["GET", "/marketing/v3/emails/123?archived=true"],
    ]) {
      expect(() => assertAllowedHubspotCall(method, path), `${method} ${path}`).toThrow(/Blocked HubSpot call/);
    }
  });
});
