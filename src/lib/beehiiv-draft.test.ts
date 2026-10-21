import { describe, expect, it } from "vitest";
import { assertSafeDraftCreate, HOWTO_POST_TEMPLATE_IDS, SKILL_LEAP_MEMBERS_SEGMENT_ID } from "@/lib/beehiiv";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { beehiivSlug, buildBeehiivDraftRequest, unboldHeadings } from "./beehiiv-draft";

describe("beehiiv draft request", () => {
  it("slugs the subject + send date the team's way", () => {
    expect(beehiivSlug("ChatGPT Reads the Fine Print So You Don't Have To", "2026-09-29")).toBe("chatgpt-reads-the-fine-print-so-you-dont-have-to-09-29-2026");
    expect(beehiivSlug("Notes → A Plan, Fast!", "2026-10-27")).toBe("notes-a-plan-fast-10-27-2026");
  });

  it("strips bold from headings only", () => {
    expect(unboldHeadings("<h2><strong>Title</strong></h2><p><strong>keep</strong></p>")).toBe("<h2>Title</h2><p><strong>keep</strong></p>");
  });

  it("builds a request the safety guard accepts: Kevin template, draft, Skill Leap excluded, display flags off", () => {
    const template = DEFAULT_TEMPLATES["how-to newsletter - futurepedia (pilot)"];
    const body = buildBeehiivDraftRequest({
      template,
      subject: "Turn Meeting Notes Into a Plan",
      previewText: "A 10-minute workflow",
      sendDate: "2026-10-27",
      sections: template.sections.map((s) => ({ key: s.key, markdown: `**${s.key}** text` })),
      sponsor: { copy: "Get the free guide", landingUrl: "https://example.com/guide" },
      thumbnailUrl: "https://img.youtube.com/vi/abcdefghijk/maxresdefault.jpg",
    });
    expect(() => assertSafeDraftCreate(JSON.parse(JSON.stringify(body)))).not.toThrow();
    expect(body).toMatchObject({
      status: "draft",
      post_template_id: HOWTO_POST_TEMPLATE_IDS.kevin,
      email_settings: { display_title_in_email: false, display_subtitle_in_email: false, email_subject_line: "Turn Meeting Notes Into a Plan" },
      web_settings: { slug: "turn-meeting-notes-into-a-plan-10-27-2026" },
    });
    expect((body.recipients as { email: { exclude_segment_ids: string[] } }).email.exclude_segment_ids).toEqual([SKILL_LEAP_MEMBERS_SEGMENT_ID]);
    expect(body.body_content).toContain("<h3>Free Resource</h3>");
    expect(body.body_content).toContain("Get the free guide");
    expect(body).not.toHaveProperty("scheduled_at");
  });

  it("Saj's format starts from Saj's template", () => {
    const template = DEFAULT_TEMPLATES["how-to newsletter - skill leap (pilot)"];
    const body = buildBeehiivDraftRequest({ template, subject: "S", previewText: null, sendDate: "2026-10-30", sections: [], sponsor: null, thumbnailUrl: null });
    expect(body.post_template_id).toBe(HOWTO_POST_TEMPLATE_IDS.saj);
  });
});
