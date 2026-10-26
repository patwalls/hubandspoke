// Worker/server-only: a ready How-To draft → the beehiiv create-post request
// (an UNSENT draft; beehiiv.ts refuses anything else). The email goes over as
// ONE `html` block holding exactly what the editor's canvas shows
// (renderEmailBody — the template's design, every style inline; beehiiv
// strips <style>/<link>, keeps inline styles), followed by the native
// feedback-poll block (a poll can't be HTML). The base template ("Hub &
// Spoke", an emptied copy of the Saj template) supplies the fonts and the
// footer. Same as the HubSpot push since 2026-10-26: what you see in Hub &
// Spoke is what lands in beehiiv, so a design change needs no push-side
// work. Mirrors the team's Claude-skill push: subject + preview from the
// draft, slug "<subject>-MM-DD-YYYY", display flags off, free tier, Skill
// Leap members excluded.
import { HOWTO_AUTHOR_IDS, HOWTO_BASE_TEMPLATE_ID, HOWTO_POLL_ID, SKILL_LEAP_MEMBERS_SEGMENT_ID } from "@/lib/beehiiv";
import { renderEmailBody } from "@/lib/newsletter-email-html";
import type { DocNode } from "@/lib/newsletter-rich-doc";
import type { ChosenScreenshot } from "@/lib/newsletter-screenshots";
import type { ComposeSponsor, NewsletterSection, NewsletterTemplate, NewsletterVariables } from "@/lib/newsletter-template";

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

/** The poll's own card (the Kevin/Saj templates' last card; the block shows its own question). */
function pollCard(): Record<string, unknown> {
  return {
    type: "section",
    visual_settings: { border_color: "#273653", border_style: "solid", border_width: 2, border_radius: 5, background_color: "#FFFFFF", inner_spacing: 16, outer_spacing_bottom: 16 },
    blocks: [{ type: "poll", poll_id: HOWTO_POLL_ID }],
  };
}

export function buildBeehiivDraftRequest(args: {
  template: NewsletterTemplate;
  subject: string;
  previewText: string | null;
  sendDate: string;
  sections: NewsletterSection[];
  sponsor: ComposeSponsor | null;
  thumbnailUrl: string | null;
  /** Kevin or Saj from the video's channel (one-format newsletters); else the template's author. */
  author?: "kevin" | "saj" | null;
  /** Picked screenshots (newsletter_drafts.screenshots) and the public link for each, by S3 key. */
  screenshots?: Record<string, ChosenScreenshot> | null;
  screenshotUrls?: Record<string, string> | null;
  /** This issue's own design, when the editor changed a designed part; else the template's. */
  layout?: DocNode | null;
  /** The issue's values for the template's `{fields}`. */
  variables?: NewsletterVariables | null;
}): Record<string, unknown> {
  if (!args.template.beehiiv) throw new Error("this format has no beehiiv setup");
  const html = renderEmailBody({
    template: args.template,
    sections: args.sections,
    sponsor: args.sponsor,
    // Picked screenshots go in as public links; a placeholder with no pick is left out of the email.
    screenshots: { chosen: args.screenshots, urlFor: (c) => args.screenshotUrls?.[c.key] ?? null },
    personalization: "raw",
    layout: args.layout ?? null,
    variables: args.variables ?? null,
  });
  const blocks: Record<string, unknown>[] = [{ type: "html", html }];
  if (args.template.beehiiv.layout.poll) blocks.push(pollCard());

  return {
    title: args.subject,
    subtitle: args.previewText ?? undefined,
    post_template_id: HOWTO_BASE_TEMPLATE_ID,
    blocks,
    status: "draft",
    guest_author_ids: [HOWTO_AUTHOR_IDS[args.author ?? args.template.beehiiv.author]],
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
