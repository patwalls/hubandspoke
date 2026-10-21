// Worker/server-only: a ready How-To draft → the beehiiv create-post request
// (an UNSENT draft; beehiiv.ts refuses anything else). beehiiv's API can't fill
// a template's placeholders, so this rebuilds the Kevin/Saj template's layout
// as NATIVE blocks (editable in beehiiv, where the team adds screenshots),
// read off both templates 2026-10-21: masthead → navy intro card → blue
// "<Tool> Guide" card (headline, thumbnail, example, Why <Tool> Works, How We
// Did It) → navy Free Resource card → blue "<Tool> Guide Continued" card
// (ending in the Watch The Full Video button) → navy Use Cases → blue Bonus
// Tips → outro image → navy feedback-poll card. The base template ("Hub &
// Spoke", an emptied copy of the Saj template) supplies the fonts, colors and
// footer (social icons, HubSpot Media cross-promo, privacy, unsubscribe).
// Mirrors the team's Claude-skill push: subject + preview from the draft, slug
// "<subject>-MM-DD-YYYY", display flags off, free tier, Skill Leap members
// excluded, headings never bold. If the team redesigns the template, update
// the look here.
import { HOWTO_AUTHOR_IDS, HOWTO_BASE_TEMPLATE_ID, HOWTO_POLL_ID, SKILL_LEAP_MEMBERS_SEGMENT_ID } from "@/lib/beehiiv";
import { markdownToBlocks, type Block } from "@/lib/beehiiv-blocks";
import { sponsorBlock, type ComposeSponsor, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

const IMG = "https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,onerror=redirect,quality=80,width=1920,height=3840/uploads/asset/file";
const MASTHEAD = `${IMG}/b45bfe96-6326-4341-b2e9-60f6f12a0768/Futurepedia_Masthead.png`;
const OUTRO = `${IMG}/c6c68c83-619a-439a-9406-b2246b1aa1f6/Futurepedia_Outro_Pic.png`;
const NAVY = "#273653";
const BLUE = "#00AEEF";

/** A template card: a bordered section (navy or blue border, as the Kevin/Saj templates alternate). */
function card(border: string, background: string, blocks: Block[]): Block {
  return {
    type: "section",
    visual_settings: { border_color: border, border_style: "solid", border_width: 2, border_radius: 5, background_color: background, inner_spacing: 16, outer_spacing_bottom: 16 },
    blocks,
  };
}

/** The small blue label at the top of a card ("Claude Guide", "Free Resource"). */
function eyebrow(text: string): Block {
  return { type: "heading", level: "4", anchorHeader: false, anchorIncludeInToc: false, formattedText: [{ text, text_color: BLUE }] };
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
}): Record<string, unknown> {
  if (!args.template.beehiiv) throw new Error("this format has no beehiiv setup");
  const md = (key: string) => {
    const sec = args.template.sections.find((s) => s.key === key);
    if (sec?.kind === "sponsor" && args.sponsor?.copy) return sponsorBlock(args.sponsor.copy, args.sponsor.landingUrl);
    return args.sections.find((x) => x.key === key)?.markdown ?? "";
  };
  const blocks = (key: string, buttons = false) => markdownToBlocks(md(key), { buttons });
  const tool = toolFromWhy(md("why")) ?? "AI";
  const stepsHeading = args.template.sections.find((s) => s.key === "steps")?.heading ?? "How We Did It";
  const content: Block[] = [
    { type: "image", imageUrl: MASTHEAD, alt_text: "Futurepedia" },
    card(NAVY, "#FFFFFF", blocks("intro")),
    card(BLUE, "#FCFCFC", [eyebrow(`${tool} Guide`), ...blocks("article"), ...blocks("why"), heading3(stepsHeading), ...blocks("steps")]),
    card(NAVY, "#FFFFFF", [eyebrow("Free Resource"), ...blocks("free_resource", true)]),
    card(BLUE, "#FFFFFF", [eyebrow(`${tool} Guide Continued`), ...blocks("steps_continued", true)]),
    card(NAVY, "#FFFFFF", [eyebrow("Use Cases"), ...blocks("use_cases")]),
    card(BLUE, "#FFFFFF", [eyebrow("Bonus Tips"), ...blocks("bonus_tips")]),
    { type: "image", imageUrl: OUTRO, alt_text: "Futurepedia" },
    card(NAVY, "#FFFFFF", [heading3("How was Futurepedia today?"), { type: "poll", poll_id: HOWTO_POLL_ID }]),
  ];
  const nonEmpty = content.filter((b) => b.type !== "section" || (b.blocks as Block[]).length > 1);
  return {
    title: args.subject,
    subtitle: args.previewText ?? undefined,
    post_template_id: HOWTO_BASE_TEMPLATE_ID,
    blocks: nonEmpty,
    status: "draft",
    guest_author_ids: [HOWTO_AUTHOR_IDS[args.template.beehiiv.author]],
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
