import { describe, expect, it } from "vitest";
import { draftEmailHtml, type DraftForHtml } from "./newsletter-draft-html";
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
