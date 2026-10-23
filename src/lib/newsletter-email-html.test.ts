import { describe, expect, it } from "vitest";
import { markdownToEmailHtml, renderEmailBody, renderEmailHtml, renderEmailParts, sectionMarkdown } from "./newsletter-email-html";
import { DEFAULT_TEMPLATES, styleSchema } from "./newsletter-template";

const style = styleSchema.parse({});
const sb = DEFAULT_TEMPLATES["sunday breakfast"];

describe("markdownToEmailHtml", () => {
  it("renders headings, lists and links with inline styles only, links opening in a new tab", () => {
    const html = markdownToEmailHtml("## This week\n\n- [Watch](https://youtu.be/abc)\n- **Bold**", style);
    expect(html).toMatch(/<p style="[^"]*font-size:21px[^"]*">This week<\/p>/);
    expect(html).toMatch(/<a href="https:\/\/youtu.be\/abc" target="_blank" style="color:#197bbd;[^"]*">Watch<\/a>/);
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).not.toMatch(/class=|<style/);
  });

  it("shows raw HTML as text and drops unsafe link schemes", () => {
    const html = markdownToEmailHtml('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![p](data:image/png;base64,AAAA)', style);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:image");
    expect(html).toContain("x"); // the link's text survives
  });

  it("keeps a numbered list's start number (steps split by an image stay numbered)", () => {
    const html = markdownToEmailHtml("4. Four\n5. Five", style);
    expect(html).toContain('<ol start="4"');
  });

  it("turns a line that is only a link into a button when asked, else a plain link", () => {
    const md = "Grab it:\n\n**[Check it out HERE](https://lp.example)**";
    const plain = markdownToEmailHtml(md, style);
    expect(plain).not.toContain("<table");
    const button = markdownToEmailHtml(md, { ...style, buttonColor: "#6b72c4" }, { buttons: true });
    expect(button).toContain('<td align="center" style="background:#6b72c4;');
    expect(button).toContain('href="https://lp.example"');
    expect(button).toContain("color:#ffffff");
    // A link with other words around it stays inline.
    expect(markdownToEmailHtml("See [this](https://x.example) now", style, { buttons: true })).not.toContain("<table");
  });

  it("fits images (full-size video frames) to the email's width and rounds them", () => {
    const html = markdownToEmailHtml("![the dashboard](https://s3.example.com/f.jpg)", style);
    expect(html).toContain('src="https://s3.example.com/f.jpg"');
    expect(html).toContain('width="552"');
    expect(html).toContain("max-width:552px");
    expect(html).toContain("border-radius:10px");
    expect(html).not.toContain("data-img");
  });

  it("on the canvas, images and screenshot spots carry the editor's handles", () => {
    const html = markdownToEmailHtml("![a](https://x.example/a.jpg)\n\n![b](https://x.example/b.jpg)", style, { canvas: true });
    expect(html).toContain('class="nlc-img" data-img="0"');
    expect(html).toContain('class="nlc-img" data-img="1"');
  });

  it("single newlines break the line (what the editor shows is what sends)", () => {
    expect(markdownToEmailHtml("Hey!\nWelcome.", style)).toContain("Hey!<br>Welcome.");
  });
});

describe("sectionMarkdown + screenshots", () => {
  const sec = { ...sb.sections[1], key: "steps", screenshots: true };
  const sections = [{ key: "steps", markdown: "**1. Open it**\nClick.\n\n*[Screenshot @ 4:32: the Skills page]*\n\n**2. Next**" }];

  it("swaps a picked placeholder for its image and leaves an unpicked one out of the email", () => {
    const chosen = { "steps:the skills page": { frameId: "f1", sec: 272, bucket: "b", key: "k/1.jpg" } };
    const withPick = sectionMarkdown({ template: sb, sections, screenshots: { chosen, urlFor: () => "https://cdn.example/1.jpg" } }, sec);
    expect(withPick).toContain("](https://cdn.example/1.jpg)");
    expect(withPick).not.toContain("[Screenshot");
    const html = markdownToEmailHtml(withPick, style);
    expect(html).toContain('alt="the Skills page"');
    expect(html).not.toContain("__shot__");
    const noPick = sectionMarkdown({ template: sb, sections, screenshots: null }, sec);
    expect(noPick).not.toContain("Screenshot");
    expect(noPick).toContain("**2. Next**");
  });

  it("on the canvas an unpicked placeholder is a dashed spot with its handle, and steps without one get an add point", () => {
    const parts = renderEmailParts({ template: { ...sb, sections: [sec] }, sections, canvas: true });
    const s = parts.sections[0];
    expect(s.content).toContain('data-shot="steps:the skills page"');
    expect(s.content).toContain("border:2px dashed");
    expect(s.content).toContain("@ 4:32");
    expect(s.addPoints.map((p) => p.n)).toEqual([2]);
  });
});

describe("renderEmailParts / renderEmailBody / renderEmailHtml", () => {
  const args = {
    template: sb,
    sections: [
      { key: "intro", markdown: "Hey!" },
      { key: "orange_juice", markdown: "**[$50K/Month App](https://x.example)**" },
    ],
    sponsor: { copy: "Free CRM", landingUrl: "https://lp.example" },
    subject: "Hi",
    previewText: "Starter Story Sunday Breakfast",
  };

  it("renders the masthead, the colored course pills, the tinted sponsor box with a button, and skips empty sections", () => {
    const parts = renderEmailParts(args);
    expect(parts.masthead).toContain(sb.style.mastheadImageUrl!);
    expect(parts.masthead).toContain("background:#EBECFC");
    const oj = parts.sections.find((s) => s.key === "orange_juice")!;
    expect(oj.heading).toContain("background:#fed7aa");
    expect(oj.heading).toContain("The Orange Juice 🍊");
    const special = parts.sections.find((s) => s.key === "special")!;
    expect(special.content).toContain("background:#EBECFC;border-radius:12px");
    expect(special.content).toContain("Free CRM");
    expect(special.content).toContain('href="https://lp.example"');
    expect(special.content).toContain("background:#6B72C4"); // the CTA is a button
    expect(parts.sections.find((s) => s.key === "coffee")!.content).toBe("");
    expect(parts.sections.find((s) => s.key === "coffee")!.empty).toBe(true);
    const body = renderEmailBody(args);
    // Empty sections leave no heading behind in the sent email.
    expect(body).not.toContain("The Coffee ☕");
    expect(body).toContain("The Orange Juice 🍊");
    expect(body).not.toContain("nlc-");
    expect(body).not.toContain("<style");
  });

  it("template previews show the instructions where content goes, and the sample boxes", () => {
    const parts = renderEmailParts({ template: sb, sections: [], showHints: true });
    expect(parts.sections.find((s) => s.key === "orange_juice")!.content).toContain("flagship story");
    const how = DEFAULT_TEMPLATES["futurepedia newsletter"];
    const steps = renderEmailParts({ template: how, sections: [], showHints: true }).sections.find((s) => s.key === "steps")!;
    expect(steps.content).toContain("Screenshots go here");
  });

  it("escapes template text, and the document carries the preheader, the page background and the 600px frame", () => {
    const t = { ...DEFAULT_TEMPLATES["daily seinfeld"], sections: [{ ...DEFAULT_TEMPLATES["daily seinfeld"].sections[1], heading: "<b>x</b>" }] };
    const html = renderEmailHtml({ template: t, sections: [{ key: "hook", markdown: "<script>alert(1)</script> hi" }], previewText: "Preview!" });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain("Preview!");
    expect(html).toContain('width="600"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain(`background:${t.style.pageBackground}`);
  });

  it("a label section (Daily Seinfeld's Read Time) is a small inline label, not a paragraph", () => {
    const ds = DEFAULT_TEMPLATES["daily seinfeld"];
    const part = renderEmailParts({ template: ds, sections: [{ key: "read_time", markdown: "Read Time: 47 sec." }] }).sections[0];
    expect(part.content).toContain("font-size:13px");
    expect(part.content).toContain("Read Time: 47 sec.");
    expect(part.content).not.toContain("<p");
  });
});

describe("buttons written as [button: …] and personalization tokens", () => {
  it("a [button: Text](url) link is a button in any section; inline it's a plain link without the prefix", () => {
    const html = markdownToEmailHtml("[button: Watch the episode](https://x.example)", style);
    expect(html).toContain('<td align="center" style="background:#197bbd;');
    expect(html).toContain(">Watch the episode</a>");
    const inline = markdownToEmailHtml("See [button: this](https://x.example) now", style);
    expect(inline).not.toContain("<table");
    expect(inline).toContain(">this</a>");
  });

  it("{{first_name}} shows a sample in the preview and HubL with a fallback in the push", () => {
    expect(markdownToEmailHtml("Hey {{first_name}}!", style)).toContain("Hey Pat!");
    expect(markdownToEmailHtml("Hey {{first_name}}!", style, { personalization: "hubspot" })).toContain("Hey {{ contact.firstname|default('there') }}!");
    expect(markdownToEmailHtml("Hey {{first_name}}!", style, { personalization: "raw" })).toContain("Hey {{first_name}}!");
    const body = renderEmailBody({ template: sb, sections: [{ key: "intro", markdown: "Hey {{first_name}}!" }], personalization: "hubspot" });
    expect(body).toContain("contact.firstname");
  });
});
