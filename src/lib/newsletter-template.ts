// A newsletter format's TEMPLATE: the ordered sections every issue has,
// stored on `formats.newsletter_template` (editable on the format page) and
// falling back to DEFAULT_TEMPLATES by format name. The drafter writes one
// Markdown block per section key; the editor edits / regenerates sections one
// at a time; composeIssue() turns the sections back into the issue body.
//
// Pure (zod + no DB), so the page, the worker and the routes share it.
//
// A section's `heading` is rendered above its content. `null` = no fixed
// heading: the section writes its own (e.g. the How-To's dynamic article
// headline). kind "sponsor" = the sponsored slot (The Special / Free
// Resource): filled from the Asana promo calendar when booked, so the agent
// only writes it when nothing is.

import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "a hex color like #fed7aa");

/**
 * The email's look: rendered by renderEmailHtml (newsletter-email-html.ts)
 * — the one renderer behind the editor's canvas, the format page's thumbnail
 * and the HubSpot push, so what you see is what lands in the inbox. Edited on
 * the format page (Look panel).
 */
export const styleSchema = z.object({
  mastheadImageUrl: z.string().url().nullable().default(null),
  mastheadLinkUrl: z.string().url().nullable().default(null),
  mastheadBackground: color.nullable().default(null),
  /** A system stack: what every mail client has, no web-font gamble. */
  fontFamily: z.string().max(200).default("-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"),
  /** Headings, card labels and buttons (e.g. Futurepedia's Poppins); null = the body font. */
  headingFont: z.string().max(200).nullable().default(null),
  /** Weight of titles (the big headings); smaller headings stay bold. Futurepedia's Poppins titles are 500. */
  headingWeight: z.number().int().min(300).max(900).default(700),
  textColor: color.default("#222222"),
  headingColor: color.default("#111111"),
  linkColor: color.default("#197bbd"),
  /** Buttons (a link alone on its line in a section with "links become buttons"). Empty = the link color. */
  buttonColor: color.nullable().default(null),
  /** Behind the email (preview only: in HubSpot the email tool's own page shows around it). */
  pageBackground: color.default("#f4f4f5"),
  contentBackground: color.default("#ffffff"),
  /** Faint rule between sections. */
  dividers: z.boolean().default(true),
});
export type NewsletterStyle = z.infer<typeof styleSchema>;

/**
 * What kind of story a section features — where the drafter LOOKS for it
 * (story-plan.ts builds the suggested lineup from these). The section's `hint`
 * says what to pick among those and how to write it. A suggestion, not a quota.
 */
export const STORY_KINDS = ["none", "newest_video", "recent_video", "case_study", "any"] as const;
export type StoryKind = (typeof STORY_KINDS)[number];
export const STORY_KIND_LABELS: Record<StoryKind, string> = {
  none: "No story (intro, sign-off…)",
  newest_video: "Most recent video",
  recent_video: "Another recent video",
  case_study: "Case study (else a recent video)",
  any: "Video or case study",
};

export const sectionSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "lowercase letters, digits and _ only"),
  heading: z.string().max(120).nullable(),
  headingLevel: z.union([z.literal(2), z.literal(3)]).default(2),
  kind: z.enum(["text", "sponsor"]).default("text"),
  /** What goes in this section — read by the drafter. */
  hint: z.string().max(2000),
  /** Roundups: what kind of story this section features (unset = none). */
  story: z.enum(STORY_KINDS).optional(),
  /** Heading shown as a rounded colored pill (Sunday Breakfast's courses). Null = plain heading. */
  pillColor: color.nullable().default(null),
  /** Tinted box behind the section's content (e.g. the sponsor); for a "label" section, the label's color. */
  boxColor: color.nullable().default(null),
  /**
   * "label": the content is drawn as a small rounded label sized to its text
   * (Daily Seinfeld's "Read Time" block in the HubSpot email). "text": normal.
   */
  look: z.enum(["text", "label"]).default("text"),
  /**
   * The drafter adds `*[Screenshot @ M:SS: …]*` placeholders here, and Hub &
   * Spoke fills each with a frame from the section's video (the issue's video,
   * or the section's story video in a roundup). Any newsletter, any section.
   */
  screenshots: z.boolean().default(false),
  /**
   * The section shows its video's thumbnail (the issue's video, or the
   * section's story video in a roundup): the drafter places it as an image,
   * and in the editor it's an image block that can be swapped or removed.
   */
  thumbnail: z.boolean().default(false),
  /**
   * How the section's bullets are laid out (beehiiv push + preview): "list" a
   * bulleted list; "lines" one paragraph, one item per line (the Kevin/Saj
   * ✅ block); "paragraphs" one paragraph per item, no bullets (their Use
   * Cases and Bonus Tips).
   */
  bullets: z.enum(["list", "lines", "paragraphs"]).default("list"),
  /** A line that is only a link becomes a button (the sponsor's CTA, "Watch the full video"). HubSpot-style templates; beehiiv cards have their own setting. */
  linkButtons: z.boolean().default(false),
  /** The drafter may leave this section out of an issue when there's nothing worth saying in it (a submission with it empty is accepted). */
  optional: z.boolean().default(false),
});

/**
 * Which HubSpot email a draft is made from: the push copies `templateEmailId`
 * (for its sender, lists, subscription type and footer), replaces the copy's
 * layout with ONE rich-text block holding the whole email as Hub & Spoke
 * renders it (renderEmailHtml) plus that footer, and names it `emailName`.
 * The look (masthead, headings, colors, buttons) is this template's `style`
 * and sections, not the HubSpot email's. `blocks` is the retired per-section
 * mapping (before 2026-10-23), kept so saved templates still parse.
 */
export const hubspotMappingSchema = z.object({
  templateEmailId: z.string().regex(/^\d+$/, "the HubSpot email id (digits)"),
  blocks: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * The draft email's name in HubSpot. Tokens: {brand}, {Month} (October),
   * {Mon} (Oct), {D} (25) — from the send date.
   */
  emailName: z.string().max(200).default("{brand} | Newsletter | {Month} {D}"),
});
export type HubspotMapping = z.infer<typeof hubspotMappingSchema>;

/**
 * The beehiiv email's layout (Futurepedia): the Kevin/Saj template's cards,
 * rebuilt as native blocks by the push (beehiiv-draft.ts) and drawn by the
 * format page's preview — one definition, so what you see is what lands in
 * beehiiv. Each card is a bordered section with an optional blue label
 * ("{tool} Guide" — {tool} = the tool named in the Why section) holding one or
 * more template sections. The base beehiiv template supplies fonts + footer.
 */
export const beehiivCardSchema = z.object({
  label: z.string().max(80).default(""),
  border: color.default("#273653"),
  background: color.default("#FFFFFF"),
  sections: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        /** Show the section's name as a heading inside the card (e.g. "How We Did It"). */
        showHeading: z.boolean().default(false),
        /** A line that is only a link becomes a button (the offer CTA, "Watch The Full Video"). */
        linkButtons: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type BeehiivCard = z.infer<typeof beehiivCardSchema>;

export const beehiivLayoutSchema = z.object({
  mastheadImageUrl: z.string().url().nullable().default(null),
  outroImageUrl: z.string().url().nullable().default(null),
  /** Card labels ("Claude Guide", "Free Resource"). */
  labelColor: color.default("#00AEEF"),
  buttonColor: color.default("#273653"),
  /** The "How was Futurepedia today?" feedback poll after the cards. */
  poll: z.boolean().default(true),
  cards: z.array(beehiivCardSchema).min(1).max(12),
});
export type BeehiivLayout = z.infer<typeof beehiivLayoutSchema>;

const BEEHIIV_IMG = "https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,onerror=redirect,quality=80,width=1920,height=3840/uploads/asset/file";
const NAVY = "#273653";
const BLUE = "#00AEEF";
/** The Kevin/Saj template's layout, read off both templates 2026-10-21. */
export const DEFAULT_BEEHIIV_LAYOUT: BeehiivLayout = {
  mastheadImageUrl: `${BEEHIIV_IMG}/b45bfe96-6326-4341-b2e9-60f6f12a0768/Futurepedia_Masthead.png`,
  outroImageUrl: `${BEEHIIV_IMG}/c6c68c83-619a-439a-9406-b2246b1aa1f6/Futurepedia_Outro_Pic.png`,
  labelColor: BLUE,
  buttonColor: NAVY,
  poll: true,
  cards: [
    { label: "", border: NAVY, background: "#FFFFFF", sections: [{ key: "intro", showHeading: false, linkButtons: false }] },
    {
      label: "{tool} Guide",
      border: BLUE,
      background: "#FCFCFC",
      sections: [
        { key: "article", showHeading: false, linkButtons: false },
        { key: "why", showHeading: false, linkButtons: false },
        { key: "steps", showHeading: true, linkButtons: false },
      ],
    },
    { label: "Free Resource", border: NAVY, background: "#FFFFFF", sections: [{ key: "free_resource", showHeading: false, linkButtons: true }] },
    { label: "{tool} Guide Continued", border: BLUE, background: "#FFFFFF", sections: [{ key: "steps_continued", showHeading: false, linkButtons: true }] },
    { label: "Use Cases", border: NAVY, background: "#FFFFFF", sections: [{ key: "use_cases", showHeading: false, linkButtons: false }] },
    { label: "Bonus Tips", border: BLUE, background: "#FFFFFF", sections: [{ key: "bonus_tips", showHeading: false, linkButtons: false }] },
  ],
};

/**
 * Where a draft goes in beehiiv (Futurepedia): whose edition it is (Kevin /
 * Saj — the video's channel overrides it for the one-format newsletter) and
 * the email's card layout. The push only ever creates an unsent draft.
 */
export const beehiivMappingSchema = z.object({
  author: z.enum(["kevin", "saj"]),
  layout: beehiivLayoutSchema.default(DEFAULT_BEEHIIV_LAYOUT),
});
export type BeehiivMapping = z.infer<typeof beehiivMappingSchema>;

export const newsletterTemplateSchema = z
  .object({
    version: z.literal(1),
    style: styleSchema.default(styleSchema.parse({})),
    hubspot: hubspotMappingSchema.nullable().default(null),
    beehiiv: beehiivMappingSchema.nullable().default(null),
    sections: z.array(sectionSchema).min(1).max(20),
    /**
     * How this newsletter reads, learned from its past issues (the template
     * learner, `newsletter-template-learn`) or written by hand: voice, rhythm,
     * how issues open and close, subject-line habits, what varies issue to
     * issue. Goes into the drafter's system prompt next to the Skill.
     */
    styleNotes: z.string().max(6000).nullable().default(null),
    /**
     * The email's DESIGN as a document (newsletter-layout.ts): masthead,
     * headings, pills, boxes, dividers, fixed text and one `slot` per section.
     * Null on templates saved before 2026-10-23 (`layoutFor` builds it from
     * the sections' old look settings). Not used by beehiiv templates.
     */
    layout: z
      .custom<{ type: "doc"; content?: unknown[] }>((v) => !!v && typeof v === "object" && (v as { type?: unknown }).type === "doc", "layout must be a document")
      .nullable()
      .default(null),
    /** When / from how many issues `styleNotes` and the sections were learned. */
    learnedAt: z.string().nullable().default(null),
    learnedFrom: z.number().int().min(0).nullable().default(null),
    /**
     * Locked: only each section's instructions can be edited (by anyone with
     * the drafter); everything else — sections, keys, types, settings, the
     * layout — only by a template admin (flag `newsletterTemplateAdmin`). For
     * templates whose push depends on the exact structure (beehiiv's cards).
     */
    locked: z.boolean().default(false),
  })
  .refine((t) => new Set(t.sections.map((s) => s.key)).size === t.sections.length, "section keys must be unique")
  .refine((t) => t.sections.filter((s) => s.kind === "sponsor").length <= 1, "at most one sponsor section");

export type NewsletterTemplate = z.infer<typeof newsletterTemplateSchema>;
export type NewsletterTemplateSection = z.infer<typeof sectionSchema>;

/** The story a section is about (a course in Sunday Breakfast, Daily Seinfeld's story). */
export interface SectionSource {
  kind: "video" | "case_study";
  /** Stable usage key: "video:<production item id>" or "case:/stories/<slug>". */
  key: string;
  title: string | null;
  url: string | null;
  /** When the story was published (ISO), when known. */
  publishedAt?: string | null;
}

/** One drafted section of an issue (stored on newsletter_drafts.sections). */
export interface NewsletterSection {
  key: string;
  markdown: string;
  /** The story this section covers, when it covers one. */
  source?: SectionSource | null;
  /** Story keys "Find new story" already offered for this section (never offered again this draft). */
  tried?: string[];
}

export function parseNewsletterTemplate(raw: unknown): NewsletterTemplate | null {
  const r = newsletterTemplateSchema.safeParse(raw);
  return r.success ? r.data : null;
}

const s = (
  key: string,
  heading: string | null,
  hint: string,
  extra: Partial<Pick<NewsletterTemplateSection, "headingLevel" | "kind" | "pillColor" | "boxColor" | "story" | "screenshots" | "look" | "thumbnail" | "bullets" | "linkButtons" | "optional">> = {},
): NewsletterTemplateSection => ({
  key,
  heading,
  hint,
  ...(extra.story ? { story: extra.story } : {}),
  headingLevel: extra.headingLevel ?? 2,
  kind: extra.kind ?? "text",
  pillColor: extra.pillColor ?? null,
  boxColor: extra.boxColor ?? null,
  screenshots: extra.screenshots ?? false,
  look: extra.look ?? "text",
  thumbnail: extra.thumbnail ?? false,
  bullets: extra.bullets ?? "list",
  linkButtons: extra.linkButtons ?? false,
  optional: extra.optional ?? false,
});

/** Starter Story's email look, read off past issues (Klaviyo/HubSpot HTML): the lavender masthead, #6B72C4 links and buttons. */
const STARTER_STORY_STYLE: NewsletterStyle = styleSchema.parse({
  mastheadImageUrl: "https://d3k81ch9hvuctc.cloudfront.net/company/Jchkiv/images/405af84f-b9e5-445e-86a4-68c2211e6876.png",
  mastheadLinkUrl: "https://www.starterstory.com/join",
  mastheadBackground: "#EBECFC",
  linkColor: "#6B72C4",
  buttonColor: "#6B72C4",
});
const NEUTRAL_STYLE: NewsletterStyle = styleSchema.parse({});

/** Templates used when a format has none saved (keyed by lowercase format name). */
export const DEFAULT_TEMPLATES: Record<string, NewsletterTemplate> = {
  "sunday breakfast": {
    version: 1,
    locked: false,
    styleNotes: null,
    layout: null,
    learnedAt: null,
    learnedFrom: null,
    style: STARTER_STORY_STYLE,
    // HubSpot account 20627419: "[TEMPLATE] Sunday Breakfast – Hub & Spoke (do
    // not send)", a copy of the Oct 11 2026 issue: sender, lists and footer.
    hubspot: {
      templateEmailId: "225070550319",
      emailName: "{brand} | Newsletter | {Month} {D}",
    },
    beehiiv: null,
    sections: [
      // Instructions hold only what's special about each section: how every
      // course is written (headline, teaser, link line) lives in the Skill, and
      // where each course's story comes from is its `story` setting.
      s(
        "intro",
        null,
        "'Hey!' on its own line, then 3 to 8 short personal lines from Pat about his week: something he's building, a trend he noticed, an event, or why this week's episode excited him. Don't summarize the email. End with 'Welcome to Sunday Breakfast!!' or 'Alright, let's get into Sunday Breakfast!'",
        { story: "none" },
      ),
      s("orange_juice", "The Orange Juice 🍊", "The issue's flagship story: the subject line usually comes from this one.", { pillColor: "#fed7aa", story: "newest_video" }),
      s("coffee", "The Coffee ☕", "", { pillColor: "#fae8ff", story: "newest_video" }),
      s(
        "special",
        "The Special 🍽️",
        "When no sponsor is booked: a free resource from list_lead_magnets that fits the week's theme, pitched like an ad: the problem, the resource, 2 to 3 dash bullets of what's inside, then a link line ('Grab the FREE guide here') to its real landing page.",
        { kind: "sponsor", pillColor: "#fae8ff", boxColor: "#EBECFC", linkButtons: true },
      ),
      s("eggs", "The Eggs 🍳", "", { pillColor: "#fef9c3", story: "case_study" }),
      s("toast", "The Toast 🍞", "", { pillColor: "#dcfce7", story: "case_study" }),
      s("pancakes", "The Pancakes 🥞", "A 'same guy as before ^^^' follow-up to an earlier course is fine when it's true.", { pillColor: "#e0f2fe", story: "case_study" }),
      s(
        "signoff",
        null,
        "'That's it!', 'I hope you have the BEST weekend and have a great week!', 'Pat' and 'Founder, StarterStory.com', each on its own line. No footer: the email template has it.",
        { story: "none" },
      ),
    ],
  },
  "daily seinfeld": {
    version: 1,
    locked: false,
    styleNotes: null,
    layout: null,
    learnedAt: null,
    learnedFrom: null,
    style: { ...STARTER_STORY_STYLE, dividers: false },
    // HubSpot account 20627419: "[TEMPLATE] Daily Seinfeld – Hub & Spoke (do
    // not send)", a copy of the Oct 15 2026 issue: sender, lists and footer.
    hubspot: {
      templateEmailId: "225078360688",
      emailName: "{brand} | Daily | {Mon}. {D}",
    },
    beehiiv: null,
    sections: [
      // HubSpot's Read Time block: a small grey label (read off the sent issues' HTML).
      s("read_time", null, "Exactly 'Read Time: N sec.' (or 'Read Time: 1 min. N sec.') for the whole email at ~200 words per minute. Nothing else.", { story: "none", look: "label", boxColor: "#e2e8f0" }),
      s(
        "hook",
        null,
        "Open with something concrete about the one story: a founder Pat just talked to, a message from a customer, a number, or a contrarian claim ('Vibe coders do not build real apps').",
        { story: "none" },
      ),
      s(
        "story",
        null,
        "Build to ONE lesson (ship fast, simplicity wins, distribution matters, you're not too late). Link the episode or case study once if it helps.",
        { story: "any" },
      ),
      s(
        "pitch",
        null,
        "Connect the lesson to the offer in the editor's notes: one or two lines on the promise and a clear call-to-action link ('Click here to secure your spot in the next bootcamp.'). No offer in the notes: a CTA to watch the full episode or read the case study. Never invent an offer, price or deadline. Then '– Pat' on its own line. No footer.",
        { story: "none" },
      ),
    ],
  },
  ...Object.fromEntries(
    (
      [
        // The one-format newsletter; its edition's author follows the video's channel (Kevin / Saj).
        ["futurepedia newsletter", "kevin"],
      ] as const
    ).map(([name, author]) => [
      name,
      {
        version: 1 as const,
        style: NEUTRAL_STYLE,
        hubspot: null,
        beehiiv: { author, layout: DEFAULT_BEEHIIV_LAYOUT },
        locked: false,
        styleNotes: null,
        layout: null,
        learnedAt: null,
        learnedFrom: null,
        sections: [
          s("intro", null, "2 to 4 short first-person lines in the channel voice, the signature on its own line, then a one-line teaser text link to the Free Resource offer, the arrow after the link: '[See the bundle](URL) →'."),
          s("article", null, "The article headline as an H2 (the how-to, benefit-first), then the video thumbnail, then the one-line concrete example.", { thumbnail: true }),
          s("why", null, "An H3 'Why [Tool] Works', a benefit-first line, then 3 to 5 ✅ lines, one per line with no bullet dash, each led by a bolded action verb ('✅ **Builds** every frame from code').", { bullets: "lines" }),
          s("steps", "How We Did It", "The first half of the 4 to 6 numbered steps, one action each. Each step: its title in bold on its own line ('**1. Pick a style in the Style Atlas**', no period), then 1 to 3 short sentences on the next line. Screenshots go on only 3 or 4 of the 6 steps in the whole issue, after the step's text, where the screen shows something the words can't. Weave a concrete business impact into at least one step.", { headingLevel: 3, screenshots: true }),
          s("free_resource", "Free Resource", "The offer: headline, 2 to 3 sentence body, 3 to 5 Key Takeaways bullets and the CTA link.", { kind: "sponsor", boxColor: "#f1f5f9" }),
          s("steps_continued", "How We Did It (continued)", "The rest of the numbered steps (continue the numbering), laid out the same way: the bold title on its own line, then 1 to 3 short sentences, with a screenshot only on the steps that need one (3 or 4 across all 6 steps). Then one closing line (an honest catch or the payoff), then the line [Watch The Full Video](VIDEO_URL) →.", { headingLevel: 3, screenshots: true }),
          s("use_cases", "Use Cases", "One intro sentence on who else this fits, then 3 to 5 lines, each its own line with no bullet dash and no emoji: a bold role label, then the point ('**Sales:** Draft a follow-up to every lead from your call notes').", { headingLevel: 3, bullets: "paragraphs" }),
          s("bonus_tips", "Bonus Tips", "2 to 3 lines, each its own line with no bullet dash: a bold directive with its colon, then the explanation ('**Keep your notes in one folder:** …'), at least one about scaling or saving time.", { headingLevel: 3, bullets: "paragraphs" }),
        ],
      },
    ]),
  ),
};

/**
 * The Futurepedia emails' look, read off the sent How-To issues (Oct 2026):
 * light blue-grey page, Open Sans body, Poppins headings / labels / buttons,
 * navy buttons, Futurepedia-blue links. Applied to a beehiiv template that
 * hasn't been redesigned in the builder yet (no `layout`).
 */
export const FUTUREPEDIA_LOOK: Partial<NewsletterStyle> = {
  fontFamily: "'Open Sans', 'Segoe UI', Helvetica, Arial, sans-serif",
  headingFont: "'Poppins', 'Segoe UI', Helvetica, Arial, sans-serif",
  headingWeight: 500,
  textColor: "#222222",
  headingColor: "#273653",
  linkColor: "#00AEEF",
  buttonColor: "#273653",
  pageBackground: "#f4f9fc",
  contentBackground: "#f4f9fc",
  dividers: false,
};

/**
 * The format's saved template, else its default, else null (free-form body).
 * Templates are never locked any more (one builder for every newsletter,
 * Pat 2026-10-23); a beehiiv template not yet redesigned takes the
 * Futurepedia look so the builder shows it as the real emails look.
 */
export function templateFor(formatName: string, saved: unknown): NewsletterTemplate | null {
  const t = parseNewsletterTemplate(saved) ?? DEFAULT_TEMPLATES[formatName.trim().toLowerCase()] ?? null;
  if (!t) return null;
  const unlocked = { ...t, locked: false };
  return t.beehiiv && !t.layout ? { ...unlocked, style: { ...t.style, ...FUTUREPEDIA_LOOK } } : unlocked;
}

/**
 * The edition's name in the queue: whatever the email tool calls it. A HubSpot
 * format → the email name from its mapping ("Starter Story | Newsletter |
 * October 25"; needs the send date); a beehiiv format → the subject line, the
 * campaign title the team uses. Null when there's nothing better than the
 * name the item already has. Pure.
 */
export function newsletterQueueTitle(
  template: NewsletterTemplate | null,
  args: { brandLabel: string; sendDate: string | null; subject: string | null },
): string | null {
  if (template?.hubspot) return args.sendDate ? hubspotEmailName(template.hubspot.emailName, args.brandLabel, args.sendDate) : null;
  if (template?.beehiiv) return args.subject?.trim() || null;
  return null;
}

export interface ComposeSponsor {
  /** Copy pulled from the promo calendar (verbatim or rewritten). */
  copy: string | null;
  landingUrl: string | null;
}

/** The sponsor block: the copy plus a CTA link when the copy doesn't carry the landing URL. */
export function sponsorBlock(copy: string, landingUrl: string | null): string {
  const text = copy.trim();
  if (!landingUrl || text.includes(landingUrl)) return text;
  return `${text}\n\n**[Check it out HERE](${landingUrl})**`;
}

/**
 * The issue body as Markdown: each template section's heading + content, in
 * template order. The sponsor section uses the promo copy when there is one,
 * else what the agent wrote (a lead magnet or a marked placeholder).
 */
export function composeIssue(
  template: NewsletterTemplate,
  sections: NewsletterSection[],
  sponsor: ComposeSponsor | null,
): string {
  const byKey = new Map(sections.map((x) => [x.key, x.markdown]));
  return template.sections
    .map((sec) => {
      const content =
        sec.kind === "sponsor" && sponsor?.copy?.trim()
          ? sponsorBlock(sponsor.copy, sponsor.landingUrl)
          : (byKey.get(sec.key) ?? "").trim();
      const heading = sec.heading ? `${"#".repeat(sec.headingLevel)} ${sec.heading}` : null;
      return [heading, content].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Why a template change isn't allowed, or null when it's fine: only which
 * HubSpot email the drafts are made from (sender, lists, footer) can't change
 * here. Pure; exported for tests.
 */
export function templateChangeProblem(current: NewsletterTemplate, next: NewsletterTemplate): string | null {
  // Templates aren't locked any more (one builder for every newsletter, 2026-10-23): only the HubSpot link is fixed.
  if (current.hubspot && JSON.stringify(current.hubspot) !== JSON.stringify(next.hubspot)) return "The HubSpot template link can't be changed here.";
  return null;
}

/** The HubSpot email name from the mapping's pattern + the send date (today when unset). Pure. */
export function hubspotEmailName(pattern: string, brandLabel: string, sendDate: string | null, now: Date = new Date()): string {
  const d = sendDate ? new Date(`${sendDate}T12:00:00Z`) : now;
  const fmt = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  return pattern
    .replace(/\{brand\}/g, brandLabel)
    .replace(/\{Month\}/g, fmt({ month: "long" }))
    .replace(/\{Mon\}/g, fmt({ month: "short" }))
    .replace(/\{D\}/g, String(d.getUTCDate()));
}
