// Worker/server-only: a ready How-To draft → the beehiiv create-post request
// (an UNSENT draft; beehiiv.ts refuses anything else). The body is our
// sections in template order, each under its card heading, starting from the
// channel's post template (Kevin / Saj). Mirrors the team's Claude-skill push:
// subject + preview from the draft, slug "<subject>-MM-DD-YYYY", both display
// flags off, free tier, Skill Leap members excluded, headings never bold.
import { HOWTO_POST_TEMPLATE_IDS, SKILL_LEAP_MEMBERS_SEGMENT_ID } from "@/lib/beehiiv";
import { markdownToEmailHtml } from "@/lib/newsletter-email-html";
import { sponsorBlock, type ComposeSponsor, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

/** "Turn Notes Into A Plan" + 2026-10-27 → "turn-notes-into-a-plan-10-27-2026". Pure; exported for tests. */
export function beehiivSlug(subject: string, sendDate: string): string {
  const base = subject
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const [y, m, d] = sendDate.split("-");
  return `${base}-${m}-${d}-${y}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Headings hold plain text (the team's "no bold on headings" rule). Structural tag strip. Pure; exported for tests. */
export function unboldHeadings(html: string): string {
  return html.replace(/<(h[1-4])([^>]*)>([\s\S]*?)<\/\1>/g, (_m, tag: string, attrs: string, inner: string) => `<${tag}${attrs}>${inner.replace(/<\/?(strong|b)>/g, "")}</${tag}>`);
}

export function buildBeehiivDraftRequest(args: {
  template: NewsletterTemplate;
  subject: string;
  previewText: string | null;
  sendDate: string;
  sections: NewsletterSection[];
  sponsor: ComposeSponsor | null;
  thumbnailUrl: string | null;
}): Record<string, unknown> {
  if (!args.template.beehiiv) throw new Error("this format has no beehiiv template set up");
  const postTemplateId = args.template.beehiiv.postTemplateId;
  if (!Object.values(HOWTO_POST_TEMPLATE_IDS).includes(postTemplateId as never)) throw new Error("unknown beehiiv post template");
  const body = args.template.sections
    .map((sec) => {
      const md = sec.kind === "sponsor" && args.sponsor?.copy ? sponsorBlock(args.sponsor.copy, args.sponsor.landingUrl) : (args.sections.find((x) => x.key === sec.key)?.markdown ?? "");
      if (!md.trim()) return "";
      const heading = sec.heading ? `<h3>${escapeHtml(sec.heading)}</h3>` : "";
      return heading + markdownToEmailHtml(md);
    })
    .filter(Boolean)
    .join("\n<hr />\n");
  return {
    title: args.subject,
    subtitle: args.previewText ?? undefined,
    post_template_id: postTemplateId,
    body_content: unboldHeadings(body),
    status: "draft",
    thumbnail_image_url: args.thumbnailUrl ?? undefined,
    recipients: { email: { tier_ids: ["free"], exclude_segment_ids: [SKILL_LEAP_MEMBERS_SEGMENT_ID] }, web: { tier_ids: ["free"] } },
    email_settings: {
      email_subject_line: args.subject,
      email_preview_text: args.previewText ?? "",
      display_title_in_email: false,
      display_subtitle_in_email: false,
    },
    web_settings: { slug: beehiivSlug(args.subject, args.sendDate) },
  };
}
