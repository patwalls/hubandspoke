import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc, type DocNode } from "./newsletter-rich-doc";

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

describe("markdownToDoc / docToMarkdown", () => {
  it("round-trips everything the drafter writes", () => {
    const cases = [
      "Hey!\nThis week I spent two days inside a founder's dashboard.",
      "**Hey {{first_name}}!**",
      "Then he built Walldare, a **crazy simple** iPhone app that *encrypts* your files.",
      "**[He Quit His $180K Job](https://www.starterstory.com/stories/x)**",
      "See [the **full** story](https://x.example/a) now.",
      "## Why It Works\n\nShort line.",
      "- one\n- two **bold**\n- three",
      "4. Four\n5. Five",
      "> A quote line",
      "Before\n\n---\n\nAfter",
      "![Video thumbnail](https://img.youtube.com/vi/abc/maxresdefault.jpg)",
      "**1. Open it**\nClick the button.\n\n*[Screenshot @ 4:32: the Skills page]*\n\n**2. Next**",
      "*[Screenshot: Image 1]*",
      "[button: Watch the episode](https://youtu.be/x)",
    ];
    for (const md of cases) expect(roundTrip(md)).toBe(md);
    // A literal asterisk comes back escaped (same text on screen and in the email); code ticks become plain text.
    expect(roundTrip("Price: 2 * 3 = 6 and a `tick`")).toBe("Price: 2 \\* 3 = 6 and a tick");
  });

  it("builds the editor's nodes: screenshot spots, buttons, the first-name token, images as their own blocks", () => {
    const doc = markdownToDoc("Hey {{first_name}}!\n\n*[Screenshot @ 1:05: the dashboard]*\n\n[button: Grab it](https://lp.example)\n\nText ![thumb](https://x/t.jpg) more");
    const types = (doc.content ?? []).map((n) => n.type);
    expect(types).toEqual(["paragraph", "screenshot", "ctaButton", "paragraph", "image", "paragraph"]);
    expect(doc.content![0].content!.map((n) => n.type)).toEqual(["text", "firstName", "text"]);
    expect(doc.content![1].attrs).toEqual({ label: "the dashboard", sec: "1:05" });
    expect(doc.content![2].attrs).toEqual({ text: "Grab it", href: "https://lp.example" });
  });

  it("serializes what the editor makes: nested bold+italic, spaces outside emphasis, typed asterisks escaped", () => {
    const doc: DocNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "plain " },
            { type: "text", text: "bold ", marks: [{ type: "bold" }] },
            { type: "text", text: "both", marks: [{ type: "bold" }, { type: "italic" }] },
            { type: "text", text: " 5*5" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "- not a list" }] },
      ],
    };
    expect(docToMarkdown(doc)).toBe("plain **bold *both*** 5\\*5\n\n\\- not a list");
    // …and that reads back as the same text.
    expect(markdownToDoc(docToMarkdown(doc)).content![1].content!.map((n) => n.text).join("")).toBe("- not a list");
  });

  it("an empty section is one empty paragraph", () => {
    expect(markdownToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(docToMarkdown({ type: "doc", content: [{ type: "paragraph" }] })).toBe("");
  });
});
