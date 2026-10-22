import { describe, expect, it } from "vitest";
import { assertSafeDraftCreate, HOWTO_AUTHOR_IDS, HOWTO_BASE_TEMPLATE_ID, SKILL_LEAP_MEMBERS_SEGMENT_ID } from "@/lib/beehiiv";
import { inlineRuns, markdownToBlocks } from "@/lib/beehiiv-blocks";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { beehiivSlug, buildBeehiivDraftRequest, toolFromWhy } from "./beehiiv-draft";

type B = Record<string, unknown> & { type: string; blocks?: B[] };

describe("markdown → beehiiv blocks", () => {
  it("turns bold, italic and links into formatted runs", () => {
    expect(inlineRuns("Hi **you** and *them*, [read](https://x.com)")).toEqual([
      { text: "Hi " },
      { text: "you", styling: ["bold"] },
      { text: " and " },
      { text: "them", styling: ["italic"] },
      { text: ", " },
      { text: "read", link: { href: "https://x.com", target: "_blank" } },
    ]);
    expect(inlineRuns("keep snake_case_words")).toEqual([{ text: "keep snake_case_words" }]);
  });

  it("makes headings, bullet lists, images and (when asked) link-only lines into buttons", () => {
    const blocks = markdownToBlocks("## Title\n- ✅ **One** thing\n- two\n![thumb](https://img/x.jpg)\n[Watch The Full Video ->](https://youtu.be/x)", { buttons: true });
    expect(blocks.map((b) => b.type)).toEqual(["heading", "list", "image", "button"]);
    expect(blocks[3]).toMatchObject({ text: "Watch The Full Video →", href: "https://youtu.be/x", visual_settings: { background_color: "#273653" } });
    expect(markdownToBlocks("[Grab the guide →](https://g.com)")[0].type).toBe("paragraph");
    expect(markdownToBlocks("Hey\n- Saj").map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });
});

describe("beehiiv draft request", () => {
  it("slugs the subject + send date the team's way", () => {
    expect(beehiivSlug("ChatGPT Reads the Fine Print So You Don't Have To", "2026-09-29")).toBe("chatgpt-reads-the-fine-print-so-you-dont-have-to-09-29-2026");
    expect(beehiivSlug("Notes → A Plan, Fast!", "2026-10-27")).toBe("notes-a-plan-fast-10-27-2026");
  });

  it("reads the tool off the Why section for the card label", () => {
    expect(toolFromWhy("### Why **Claude** Works\nbecause")).toBe("Claude");
    expect(toolFromWhy("nothing")).toBeNull();
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
      { key: "article", markdown: "## Turn Notes Into a Plan\n![thumb](https://img.youtube.com/vi/x/maxresdefault.jpg)\nOne line." },
      { key: "why", markdown: "### Why Claude Works\n- ✅ **Fast**" },
      { key: "steps", markdown: "1. **Open** it" },
      { key: "steps_continued", markdown: "4. **Ship** it\n[Watch The Full Video ->](https://youtu.be/x)" },
      { key: "use_cases", markdown: "- 📊 **Ops:** x" },
      { key: "bonus_tips", markdown: "- **Batch:** y" },
    ],
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

  it("rebuilds the template's cards in order, labelled like the template", () => {
    const cards = body.blocks.filter((b) => b.type === "section");
    const label = (c: B) => {
      const h = c.blocks![0] as { formattedText?: { text: string }[]; text?: string };
      return h.formattedText?.[0].text ?? h.text;
    };
    expect(cards.map((c) => (c.blocks![0].type === "heading" ? label(c) : "(intro)"))).toEqual([
      "(intro)",
      "Claude Guide",
      "Free Resource",
      "Claude Guide Continued",
      "Use Cases",
      "Bonus Tips",
      "How was Futurepedia today?",
    ]);
    expect(body.blocks[0]).toMatchObject({ type: "image" }); // masthead
    expect(cards[3].blocks!.at(-1)).toMatchObject({ type: "button", href: "https://youtu.be/x" });
    expect(cards[2].blocks!.at(-1)).toMatchObject({ type: "button", href: "https://example.com/guide" });
  });

  it("builds from the template's layout: relabel a card, move a section, drop the poll", () => {
    const base = DEFAULT_TEMPLATES["futurepedia newsletter"];
    const layout = base.beehiiv!.layout;
    const edited = {
      ...base,
      beehiiv: {
        ...base.beehiiv!,
        layout: {
          ...layout,
          poll: false,
          outroImageUrl: null,
          // Use Cases + Bonus Tips merged into one "Extras" card.
          cards: [
            ...layout.cards.slice(0, 4),
            { label: "Extras", border: "#111111", background: "#FFFFFF", sections: [{ key: "use_cases", showHeading: true, linkButtons: false }, { key: "bonus_tips", showHeading: true, linkButtons: false }] },
          ],
        },
      },
    };
    const out = buildBeehiivDraftRequest({
      template: edited,
      subject: "S",
      previewText: null,
      sendDate: "2026-10-30",
      sections: [
        { key: "intro", markdown: "Hi" },
        { key: "why", markdown: "### Why Claude Works" },
        { key: "use_cases", markdown: "- one" },
        { key: "bonus_tips", markdown: "- two" },
      ],
      sponsor: null,
      thumbnailUrl: null,
    }) as { blocks: B[] };
    const cards = out.blocks.filter((b) => b.type === "section");
    const last = cards.at(-1)!;
    expect((last.blocks![0] as unknown as { formattedText: { text: string }[] }).formattedText[0].text).toBe("Extras");
    expect(last.visual_settings).toMatchObject({ border_color: "#111111" });
    expect(last.blocks!.filter((b) => b.type === "heading").map((h) => (h as { text?: string }).text)).toEqual([undefined, "Use Cases", "Bonus Tips"]);
    expect(out.blocks.some((b) => b.type === "poll" || (b.blocks ?? []).some((x) => x.type === "poll"))).toBe(false);
    expect(out.blocks.filter((b) => b.type === "image")).toHaveLength(1); // masthead only
  });

  it("puts a picked screenshot in as an image where its placeholder was; unpicked ones stay text", () => {
    const template = DEFAULT_TEMPLATES["futurepedia newsletter"];
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
    const guide = out.blocks.filter((b) => b.type === "section")[0].blocks!;
    expect(guide).toContainEqual(expect.objectContaining({ type: "image", imageUrl: "https://s3.us-east-1.amazonaws.com/www.starterstory.com/k.jpg" }));
    expect(JSON.stringify(guide)).toContain("[Screenshot @ 5:10: the result]");
    expect(JSON.stringify(guide)).not.toContain("[Screenshot @ 4:32");
  });
});

