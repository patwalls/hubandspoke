// Worker/server-only: a ready How-To draft → the beehiiv create-post request
// (an UNSENT draft; beehiiv.ts refuses anything else). beehiiv's API can't fill
// a template's placeholders, so the email is built as NATIVE blocks (editable
// in beehiiv, where the team adds screenshots) from the format template's
// beehiiv LAYOUT (`template.beehiiv.layout`, edited on the format page and
// drawn by its preview; default = the Kevin/Saj layout read off both
// templates 2026-10-21): masthead → the cards, each a bordered section with an
// optional "{tool} Guide"-style label holding its sections → outro image →
// feedback-poll card. The base template ("Hub & Spoke", an emptied copy of
// the Saj template) supplies the fonts and footer. Mirrors the team's
// Claude-skill push: subject + preview from the draft, slug
// "<subject>-MM-DD-YYYY", display flags off, free tier, Skill Leap members
// excluded, headings never bold.
import { HOWTO_AUTHOR_IDS, HOWTO_BASE_TEMPLATE_ID, HOWTO_POLL_ID, SKILL_LEAP_MEMBERS_SEGMENT_ID } from "@/lib/beehiiv";
import { markdownToBlocks, type Block } from "@/lib/beehiiv-blocks";
import { applyScreenshots, type ChosenScreenshot } from "@/lib/newsletter-screenshots";
import { sponsorBlock, type ComposeSponsor, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

/** A layout card: a bordered section (the Kevin/Saj templates alternate navy and blue borders). */
function card(border: string, background: string, blocks: Block[]): Block {
  return {
    type: "section",
    visual_settings: { border_color: border, border_style: "solid", border_width: 2, border_radius: 5, background_color: background, inner_spacing: 16, outer_spacing_bottom: 16 },
    blocks,
  };
}

/** The small label at the top of a card ("Claude Guide", "Free Resource"). */
function eyebrow(text: string, color: string): Block {
  return { type: "heading", level: "4", anchorHeader: false, anchorIncludeInToc: false, formattedText: [{ text, text_color: color }] };
}

function heading3(text: string): Block {
  return { type: "heading", level: "3", anchorHeader: false, anchorIncludeInToc: false, text };
}

/** "### Why Claude Works" → "Claude" (the card label is "<Tool> Guide"). Pure; exported for tests. */
export function toolFromWhy(md: string): string | null {
  const m = md.match(/Why\s+(.+?)\s+Works/i);
  return m ? m[1].replace(/[*_#]/g, "").trim() : null;
}

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
}): Record<string, unknown> {
  if (!args.template.beehiiv) throw new Error("this format has no beehiiv setup");
  const rawMd = (key: string) => {
    const sec = args.template.sections.find((s) => s.key === key);
    if (sec?.kind === "sponsor" && args.sponsor?.copy) return sponsorBlock(args.sponsor.copy, args.sponsor.landingUrl);
    return args.sections.find((x) => x.key === key)?.markdown ?? "";
  };
  // Picked screenshots replace their placeholders as image lines (→ image blocks).
  const md = (key: string) => applyScreenshots(key, rawMd(key), args.screenshots, (c) => args.screenshotUrls?.[c.key] ?? null);

  const layout = args.template.beehiiv.layout;
  const tool = toolFromWhy(md("why")) ?? "AI";
  const sectionByKey = new Map(args.template.sections.map((sec) => [sec.key, sec]));
  const placed = new Set(layout.cards.flatMap((c) => c.sections.map((x) => x.key)));
  const cards = [...layout.cards];
  // A template section no card holds still goes out, in a plain card at the end.
  const unplaced = args.template.sections.filter((sec) => !placed.has(sec.key)).map((sec) => ({ key: sec.key, showHeading: !!sec.heading, linkButtons: false }));
  if (unplaced.length) cards.push({ label: "", border: "#273653", background: "#FFFFFF", sections: unplaced });

  const content: Block[] = [];
  if (layout.mastheadImageUrl) content.push({ type: "image", imageUrl: layout.mastheadImageUrl, alt_text: "Futurepedia" });
  for (const c of cards) {
    const inner: Block[] = [];
    if (c.label.trim()) inner.push(eyebrow(c.label.replace(/\{tool\}/g, tool), layout.labelColor));
    for (const s of c.sections) {
      const heading = sectionByKey.get(s.key)?.heading;
      if (s.showHeading && heading) inner.push(heading3(heading));
      inner.push(...markdownToBlocks(md(s.key), { buttons: s.linkButtons, buttonColor: layout.buttonColor }));
    }
    // A card with only its label (its sections are empty) is left out.
    if (inner.length > (c.label.trim() ? 1 : 0)) content.push(card(c.border, c.background, inner));
  }
  if (layout.outroImageUrl) content.push({ type: "image", imageUrl: layout.outroImageUrl, alt_text: "Futurepedia" });
  if (layout.poll) content.push(card("#273653", "#FFFFFF", [heading3("How was Futurepedia today?"), { type: "poll", poll_id: HOWTO_POLL_ID }]));

  return {
    title: args.subject,
    subtitle: args.previewText ?? undefined,
    post_template_id: HOWTO_BASE_TEMPLATE_ID,
    blocks: content,
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
