import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-text";

describe("htmlToText", () => {
  it("keeps the words and drops tags, entities and whitespace runs", () => {
    expect(htmlToText(`<table><tr><td style="x">Hello&nbsp;<b>world</b> &amp; friends&#8217;s&#x2014;day</td></tr>\n\n<td>  next </td></table>`)).toBe("Hello world & friends’s—day next");
  });

  it("drops style and script bodies entirely", () => {
    expect(htmlToText("<style>p{color:red}</style><p>Text</p><script>alert(1)</script>")).toBe("Text");
  });

  it("gives the same words for the fragment and for beehiiv's wrapped render of it", () => {
    const fragment = `<p style="margin:0">Open <a href="https://x.test/a">the app</a> → done.</p>`;
    const wrapped = `<html><body><div id="content-blocks"><div style="padding:4px 12px">${fragment.replace("https://x.test/a", "https://x.test/a?utm_source=futurepedia")}</div></div></body></html>`;
    expect(htmlToText(wrapped)).toContain(htmlToText(fragment));
  });
});
