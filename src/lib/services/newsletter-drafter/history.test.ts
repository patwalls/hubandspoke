import { describe, expect, it } from "vitest";
import { voiceFromAuthors } from "./history";

describe("voiceFromAuthors", () => {
  it("reads Kevin or Saj from beehiiv author names, as strings or objects", () => {
    expect(voiceFromAuthors(["Kevin at Futurepedia"])).toBe("Kevin");
    expect(voiceFromAuthors([{ name: "Saj Adib" }])).toBe("Saj");
  });

  it("keeps any other byline as-is, and is null without authors", () => {
    expect(voiceFromAuthors(["Futurepedia Team"])).toBe("Futurepedia Team");
    expect(voiceFromAuthors(undefined)).toBeNull();
    expect(voiceFromAuthors([])).toBeNull();
  });
});

describe("emailContent", () => {
  const email = {
    id: "1",
    content: {
      flexAreas: {
        main: {
          sections: [
            { id: "s1", columns: [{ id: "c1", widgets: ["masthead", "intro"], width: 12 }] },
            { id: "s2", columns: [{ id: "c2", widgets: ["label_oj", "div", "oj"], width: 12 }] },
            { id: "s3", columns: [{ id: "c3", widgets: ["footer"], width: 12 }] },
          ],
        },
      },
      widgets: {
        // Deliberately out of layout order: the layout wins.
        oj: { body: { path: "@hubspot/rich_text", html: "<p><a href=\"https://x\">$50K app</a></p><p>Two lines.</p>" } },
        masthead: { body: { path: "@hubspot/image_email" } },
        intro: { body: { path: "@hubspot/rich_text", html: "<p>Hey!</p><p>This week.</p>" } },
        label_oj: { body: { label_text: "The Orange Juice 🍊" } },
        div: { body: { path: "@hubspot/email_divider" } },
        footer: { body: { path: "@hubspot/email_footer", footer_html: "unsubscribe" } },
      },
    },
  };

  it("reads the email in layout order: label modules become headings, rich text its text, nothing else", async () => {
    const { emailContent } = await import("./history");
    const { html, text } = emailContent(email);
    expect(html).toBe("<p>Hey!</p><p>This week.</p>\n<h2>The Orange Juice 🍊</h2>\n<p><a href=\"https://x\">$50K app</a></p><p>Two lines.</p>");
    expect(text).toBe("Hey!\nThis week.\n\nThe Orange Juice 🍊\n\n$50K app\nTwo lines.");
    expect(text).not.toContain("unsubscribe");
  });

  it("without a layout, falls back to the widgets' own order", async () => {
    const { emailContent } = await import("./history");
    const noLayout = { id: "2", content: { widgets: { b: { order: 2, body: { path: "@hubspot/rich_text", html: "<p>B</p>" } }, a: { order: 1, body: { path: "@hubspot/rich_text", html: "<p>A</p>" } } } } };
    expect(emailContent(noLayout).text).toBe("A\n\nB");
  });
});
