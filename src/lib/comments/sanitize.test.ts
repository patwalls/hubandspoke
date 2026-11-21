import { describe, it, expect } from "vitest";
import { commentText, htmlToPlainText } from "./sanitize";

describe("commentText", () => {
  // The In Production peek showed "Review &amp; publish." — htmlToPlainText
  // keeps text escaped (it feeds HTML emails), and React escapes again.
  it("gives real characters for React to render", () => {
    const body = "<p>Review &amp; publish. 5 &lt; 6 &quot;ok&quot; it&#39;s</p>";
    expect(htmlToPlainText(body)).toContain("Review &amp; publish. 5 &lt; 6");
    expect(commentText(body)).toBe(`Review & publish. 5 < 6 "ok" it's`);
  });
  it("decodes once: a typed '&lt;' stays '&lt;'", () => {
    expect(commentText("<p>&amp;lt;</p>")).toBe("&lt;");
  });
  it("keeps paragraphs as lines", () => {
    expect(commentText("<p>one</p><p>two &amp; three</p>")).toBe("one\ntwo & three");
  });
});
