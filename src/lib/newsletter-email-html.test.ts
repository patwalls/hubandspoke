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
