import { describe, expect, it } from "vitest";
import { draftEmailHtml, liveNewsletterDocument, type DraftForHtml } from "./newsletter-draft-html";
import { DEFAULT_TEMPLATES } from "./newsletter-template";

const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];
const draft: DraftForHtml = {
  template: fp,
  sections: [
    { key: "article", markdown: "## Headline" },
    { key: "why", markdown: "### Why it works\n✅ **Reads** files" },
    { key: "steps", markdown: "1. **Open** it" },
  ],
  subject: "Subject line",
  previewText: "The preheader",
  specialCopy: null,
  specialSource: null,
  screenshots: null,
  layout: null,
  variables: { tool: "Nano Banana", steps_heading: "How To Try It" },
};

describe("draftEmailHtml (content-page preview + test send)", () => {
  it("renders the issue's own {fields}, not the template's samples", () => {
    // The test send used to drop `variables`, so its email showed the samples.
    const html = draftEmailHtml(draft, null)!;
    expect(html).toContain("Nano Banana Guide");
    expect(html).toContain("How To Try It");
    expect(html).toContain("The preheader");
    expect(html).toContain("Headline");
  });

  it("is null for an edition with no template yet", () => {
    expect(draftEmailHtml({ ...draft, template: null }, null)).toBeNull();
  });

  it("adds the footer note only when given one", () => {
    expect(draftEmailHtml(draft, "Test send note")).toContain("Test send note");
    expect(draftEmailHtml(draft, null)).not.toContain("Test send note");
  });
});

describe("liveNewsletterDocument", () => {
  it("shows the edition's designed email over the imported body", () => {
    expect(liveNewsletterDocument("<html><head></head><body>designed</body></html>", "<p>Hey!</p>")).toContain("designed");
  });

  it("sets a bare imported fragment in a styled email column", () => {
    const doc = liveNewsletterDocument(null, "<p>Hey!</p><h2>The Orange Juice</h2>")!;
    expect(doc).toContain("<head>"); // EmailFrame injects <base> there
    expect(doc).toMatch(/font:[^;]*sans-serif/);
    expect(doc).toContain("<p>Hey!</p><h2>The Orange Juice</h2>");
  });

  it("leaves a full document alone and returns null with nothing to show", () => {
    expect(liveNewsletterDocument(null, "<html><body>x</body></html>")).toBe("<html><body>x</body></html>");
    expect(liveNewsletterDocument(null, "  ")).toBeNull();
  });
});
