import { describe, expect, it } from "vitest";
import { BODY_MARKER, buildBodyWidgetPatch, templateEmailIdFor } from "./hubspot-marketing-email";

describe("templateEmailIdFor", () => {
  const env = { HUBSPOT_NEWSLETTER_TEMPLATE_EMAILS: JSON.stringify({ "Daily Seinfeld": "111", "Sunday Breakfast": 222 }) };

  it("matches the format name case-insensitively and accepts numeric ids", () => {
    expect(templateEmailIdFor("daily seinfeld", env)).toBe("111");
    expect(templateEmailIdFor("Sunday Breakfast", env)).toBe("222");
  });

  it("returns null for an unknown format, a missing env var, or malformed JSON", () => {
    expect(templateEmailIdFor("Playbook", env)).toBeNull();
    expect(templateEmailIdFor("Daily Seinfeld", {})).toBeNull();
    expect(templateEmailIdFor("Daily Seinfeld", { HUBSPOT_NEWSLETTER_TEMPLATE_EMAILS: "{nope" })).toBeNull();
  });
});

describe("buildBodyWidgetPatch", () => {
  it("replaces only the module holding the marker, keeping its other settings", () => {
    const email = {
      id: "9",
      content: {
        widgets: {
          header: { body: { html: "<p>Logo</p>" } },
          main: { type: "rich_text", body: { html: `<p>${BODY_MARKER}</p>`, css_class: "x" } },
        },
      },
    };
    expect(buildBodyWidgetPatch(email, "<p>Hello</p>")).toEqual({
      main: { type: "rich_text", body: { html: "<p>Hello</p>", css_class: "x" } },
    });
  });

  it("fails loudly when the template has no marker module", () => {
    expect(() => buildBodyWidgetPatch({ id: "9", content: { widgets: { a: { body: { html: "x" } } } } }, "y")).toThrow(
      /has no rich-text module/,
    );
  });
});
