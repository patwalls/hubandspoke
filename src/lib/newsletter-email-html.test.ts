import { describe, expect, it } from "vitest";
import { markdownToEmailHtml } from "./newsletter-email-html";

describe("markdownToEmailHtml", () => {
  it("renders headings, lists and links, opening links in a new tab", () => {
    const html = markdownToEmailHtml("## This week\n\n- [Watch](https://youtu.be/abc)\n- **Bold**");
    expect(html).toContain("<h2>This week</h2>");
    expect(html).toContain('<a href="https://youtu.be/abc" target="_blank">Watch</a>');
    expect(html).toContain("<strong>Bold</strong>");
  });

  it("drops raw HTML and unsafe link schemes from the model's markdown", () => {
    const html = markdownToEmailHtml('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });
});

describe("renderEmailHtml", () => {
  // Imported lazily so the markdownToEmailHtml tests above stay independent.
  it("renders the masthead, colored pill headings, the sponsor box with promo copy, and hints in template previews", async () => {
    const { renderEmailHtml } = await import("./newsletter-email-html");
    const { DEFAULT_TEMPLATES } = await import("./newsletter-template");
    const t = DEFAULT_TEMPLATES["sunday breakfast"];
    const html = renderEmailHtml({
      template: t,
      sections: [{ key: "orange_juice", markdown: "**[$50K/Month App](https://x.example)**" }],
      sponsor: { copy: "Free CRM", landingUrl: "https://lp.example" },
      subject: "Hi",
      previewText: "Starter Story Sunday Breakfast",
    });
    expect(html).toContain(t.style.mastheadImageUrl!);
    expect(html).toContain("background:#fed7aa"); // Orange Juice pill
    expect(html).toContain("The Orange Juice 🍊");
    expect(html).toContain("background:#EBECFC"); // sponsor box
    expect(html).toContain("Free CRM");
    expect(html).toContain('href="https://lp.example"');
    expect(html).toContain("Starter Story Sunday Breakfast"); // hidden preheader
    expect(html).not.toContain("The week's flagship YouTube video"); // no hints in a draft

    const preview = renderEmailHtml({ template: t, sections: [], showHints: true });
    expect(preview).toContain("flagship YouTube video"); // hint shown where content goes
  });

  it("escapes template text and drops raw HTML from section markdown", async () => {
    const { renderEmailHtml } = await import("./newsletter-email-html");
    const { DEFAULT_TEMPLATES } = await import("./newsletter-template");
    const t = { ...DEFAULT_TEMPLATES["daily seinfeld"], sections: [{ ...DEFAULT_TEMPLATES["daily seinfeld"].sections[0], heading: "<b>x</b>" }] };
    const html = renderEmailHtml({ template: t, sections: [{ key: "story", markdown: "<script>alert(1)</script> hi" }] });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<script");
  });
});
