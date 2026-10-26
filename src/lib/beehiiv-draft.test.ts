import { describe, expect, it } from "vitest";
import { assertSafeDraftCreate, assertSafeHtmlBlock, HOWTO_AUTHOR_IDS, HOWTO_BASE_TEMPLATE_ID, HOWTO_POLL_ID, SKILL_LEAP_MEMBERS_SEGMENT_ID } from "@/lib/beehiiv";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { beehiivSlug, buildBeehiivDraftRequest } from "./beehiiv-draft";

type B = Record<string, unknown> & { type: string; blocks?: B[]; html?: string };

describe("beehiiv draft request (the designed email as one html block)", () => {
  it("slugs the subject + send date the team's way", () => {
    expect(beehiivSlug("ChatGPT Reads the Fine Print So You Don't Have To", "2026-09-29")).toBe("chatgpt-reads-the-fine-print-so-you-dont-have-to-09-29-2026");
    expect(beehiivSlug("Notes → A Plan, Fast!", "2026-10-27")).toBe("notes-a-plan-fast-10-27-2026");
  });

  const template = DEFAULT_TEMPLATES["futurepedia newsletter"];
  const body = buildBeehiivDraftRequest({
    template,
    subject: "Turn Meeting Notes Into a Plan",
    previewText: "A 10-minute workflow",
    sendDate: "2026-10-27",
    author: "saj",
    sections: [
      { key: "intro", markdown: "Hey friends\n- Saj\n[Grab our free guide →](https://g.com)" },
      { key: "article", markdown: "## Turn Notes Into a Plan\n[![thumb](https://img.youtube.com/vi/x/maxresdefault.jpg)](https://youtu.be/x)\nOne line." },
      { key: "why", markdown: "### Why Claude Works\n- ✅ **Fast**" },
      { key: "steps", markdown: "1. **Open** it" },
      { key: "steps_continued", markdown: "4. **Ship** it\n[Watch The Full Video ->](https://youtu.be/x)" },
      { key: "use_cases", markdown: "- **Ops:** x" },
      { key: "bonus_tips", markdown: "- **Batch:** y" },
    ],
    variables: { tool: "Claude Cowork", steps_heading: "How We Did It", closer_1: "Use Cases", closer_2: "Where It Falls Short" },
    sponsor: { copy: "Get the free guide", landingUrl: "https://example.com/guide" },
    thumbnailUrl: null,
  }) as Record<string, unknown> & { blocks: B[] };

  it("passes the safety guard: a draft from the empty base template, Saj as author, Skill Leap excluded", () => {
    expect(() => assertSafeDraftCreate(JSON.parse(JSON.stringify(body)))).not.toThrow();
    expect(body).toMatchObject({
      status: "draft",
      post_template_id: HOWTO_BASE_TEMPLATE_ID,
      guest_author_ids: [HOWTO_AUTHOR_IDS.saj],
      email_settings: { display_title_in_email: false, display_subtitle_in_email: false },
      web_settings: { slug: "turn-meeting-notes-into-a-plan-10-27-2026" },
    });
    expect((body.recipients as { email: { exclude_segment_ids: string[] } }).email.exclude_segment_ids).toEqual([SKILL_LEAP_MEMBERS_SEGMENT_ID]);
    expect(body).not.toHaveProperty("scheduled_at");
    expect(body).not.toHaveProperty("body_content");
  });

  it("is one html block holding the designed email, then the poll card — nothing else", () => {
    expect(body.blocks.map((b) => b.type)).toEqual(["html", "section"]);
    expect(body.blocks[1].blocks).toEqual([{ type: "poll", poll_id: HOWTO_POLL_ID }]);
    const html = body.blocks[0].html!;
    // The design: masthead, the cards with the issue's field values, the buttons, the thumbnail linked to the video, inline styles only.
    expect(html).toContain("Futurepedia_Masthead.png");
    expect(html).toContain("Claude Cowork Guide");
    expect(html).toContain("Claude Cowork Guide Continued");
    expect(html).toContain("Where It Falls Short");
    expect(html).not.toContain("{tool}");
    expect(html).not.toContain("{closer_2}");
    expect(html).toContain('href="https://youtu.be/x"');
    expect(html).toContain("Watch The Full Video");
    expect(html).toContain("https://example.com/guide");
    expect(html).toContain("Free Resource");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<link");
    // The sign-off stays a line, not a list.
    expect(html).toContain("- Saj");
    expect(html).not.toContain("<li");
  });

  it("drops the poll when the template's beehiiv setup turns it off", () => {
    const out = buildBeehiivDraftRequest({
      template: { ...template, beehiiv: { ...template.beehiiv!, layout: { ...template.beehiiv!.layout, poll: false } } },
      subject: "S",
      previewText: null,
      sendDate: "2026-10-30",
      sections: [{ key: "intro", markdown: "Hi" }],
      sponsor: null,
      thumbnailUrl: null,
    }) as { blocks: B[] };
    expect(out.blocks.map((b) => b.type)).toEqual(["html"]);
  });

  it("puts a picked screenshot in as an image where its placeholder was; an unpicked one is left out", () => {
    const out = buildBeehiivDraftRequest({
      template,
      subject: "S",
      previewText: null,
      sendDate: "2026-10-30",
      sections: [{ key: "steps", markdown: "1. **Open Skills**\n*[Screenshot @ 4:32: the Skills page]*\n*[Screenshot @ 5:10: the result]*" }],
      sponsor: null,
      thumbnailUrl: null,
      screenshots: { "steps:the skills page": { frameId: "f1", sec: 272, bucket: "www.starterstory.com", key: "k.jpg" } },
      screenshotUrls: { "k.jpg": "https://s3.us-east-1.amazonaws.com/www.starterstory.com/k.jpg" },
    }) as { blocks: B[] };
    const html = out.blocks[0].html!;
    expect(html).toContain('src="https://s3.us-east-1.amazonaws.com/www.starterstory.com/k.jpg"');
    expect(html).not.toContain("Screenshot @ 5:10");
    expect(html).not.toContain("[Screenshot @ 4:32");
  });

  it("the guard refuses an html block that could run code or collect input", () => {
    expect(() => assertSafeHtmlBlock("<table><tr><td style=\"color:#222\">fine</td></tr></table>")).not.toThrow();
    expect(() => assertSafeHtmlBlock("<p>x</p><script>alert(1)</script>")).toThrow(/script/);
    expect(() => assertSafeHtmlBlock('<a href="javascript:void(0)">x</a>')).toThrow(/javascript/);
    expect(() => assertSafeHtmlBlock('<img src="x" onerror="alert(1)">')).toThrow(/onerror/);
    expect(() => assertSafeHtmlBlock("<form action='/x'></form>")).toThrow(/form/);
    expect(() => assertSafeHtmlBlock("")).toThrow(/needs its html/);
    expect(() => assertSafeDraftCreate({ ...body, blocks: [{ type: "html", html: "<iframe src='x'></iframe>" }] })).toThrow(/iframe/);
  });
});
