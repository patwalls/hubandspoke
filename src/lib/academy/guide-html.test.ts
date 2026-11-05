import { describe, expect, it } from "vitest";
import { renderGuideHtml, sanitizeGuideHtml } from "./guide-html";

describe("sanitizeGuideHtml", () => {
  it("keeps the editor's structure: steps, lists, figures, tips, videos", () => {
    const html =
      '<h2>Step 1: Connect</h2><p>Go to <strong>Accounts</strong> <a href="https://x.com">here</a></p>' +
      '<figure data-figure=""><img src="/api/files/hubandspoke/uploads/academy-images/a.png"><figcaption>The page</figcaption></figure>' +
      '<div data-callout="tip"><p>Tip: save often</p></div>' +
      '<div data-video-embed="https://www.loom.com/share/abc"></div><ul><li>One</li></ul>';
    const out = sanitizeGuideHtml(html);
    expect(out).toContain("<h2>Step 1: Connect</h2>");
    expect(out).toContain('<a href="https://x.com" target="_blank" rel="noopener noreferrer">here</a>');
    expect(out).toContain('<img src="/api/files/hubandspoke/uploads/academy-images/a.png" />');
    expect(out).toContain("<figcaption>The page</figcaption>");
    expect(out).toContain('<div data-callout="tip"><p>Tip: save often</p></div>');
    expect(out).toContain('<div data-video-embed="https://www.loom.com/share/abc"></div>');
  });

  it("strips scripts, event handlers, unsafe images and non-video embeds", () => {
    const out = sanitizeGuideHtml(
      '<p onclick="x()">Hi</p><script>alert(1)</script><img src="data:image/png;base64,AAA"><img src="javascript:alert(1)">' +
        '<div data-video-embed="https://evil.example/x"></div><a href="javascript:alert(1)">bad</a>',
    );
    expect(out).not.toMatch(/script|onclick|data:image|javascript:|evil\.example/);
    expect(out).toContain("<p>Hi</p>");
  });

  it("treats an empty editor as no guide", () => {
    expect(sanitizeGuideHtml("<p></p>")).toBe("");
    expect(sanitizeGuideHtml("<p>  </p><p></p>")).toBe("");
  });
});

describe("renderGuideHtml", () => {
  it("turns video placeholders into players", () => {
    const out = renderGuideHtml('<p>a</p><div data-video-embed="https://youtu.be/abc?t=1&amp;x=2"></div>');
    expect(out).toContain('<iframe src="https://www.youtube.com/embed/abc"');
    expect(out).toContain('class="academy-guide-video"');
  });
});
