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

/** The email's look: rendered by renderEmailHtml (newsletter-email-html.ts). */
export const styleSchema = z.object({
  mastheadImageUrl: z.string().url().nullable().default(null),
  mastheadLinkUrl: z.string().url().nullable().default(null),
  mastheadBackground: color.nullable().default(null),
  fontFamily: z.string().max(200).default("Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"),
  textColor: color.default("#616161"),
  headingColor: color.default("#030212"),
  linkColor: color.default("#197bbd"),
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
  /** Tinted box behind the section's content (e.g. the sponsor). */
  boxColor: color.nullable().default(null),
});

/**
 * Where each section goes in the email tool's own template email (HubSpot
 * today): the push copies `templateEmailId` and fills each mapped rich-text
 * block. Several sections may share a block (Sunday Breakfast's sign-off goes
 * at the end of the Pancakes block). Unmapped blocks (masthead, labels,
 * dividers, the fixed footer) are left exactly as they are in the template.
 */
export const hubspotMappingSchema = z.object({
  templateEmailId: z.string().regex(/^\d+$/, "the HubSpot email id (digits)"),
  /** section key → HubSpot widget id of the block it fills (a rich-text block, or a label module like Daily Seinfeld's "Read Time"). */
  blocks: z.record(z.string(), z.string().min(1)),
  /**
   * The draft email's name in HubSpot. Tokens: {brand}, {Month} (October),
   * {Mon} (Oct), {D} (25) — from the send date.
   */
  emailName: z.string().max(200).default("{brand} | Newsletter | {Month} {D}"),
});
export type HubspotMapping = z.infer<typeof hubspotMappingSchema>;

export const newsletterTemplateSchema = z
  .object({
    version: z.literal(1),
    style: styleSchema.default(styleSchema.parse({})),
    hubspot: hubspotMappingSchema.nullable().default(null),
    sections: z.array(sectionSchema).min(1).max(20),
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
  extra: Partial<Pick<NewsletterTemplateSection, "headingLevel" | "kind" | "pillColor" | "boxColor" | "story">> = {},
): NewsletterTemplateSection => ({
  key,
  heading,
  hint,
  ...(extra.story ? { story: extra.story } : {}),
  headingLevel: extra.headingLevel ?? 2,
  kind: extra.kind ?? "text",
  pillColor: extra.pillColor ?? null,
  boxColor: extra.boxColor ?? null,
});

/** Starter Story's email look, read off past issues (Klaviyo/HubSpot HTML). */
const STARTER_STORY_STYLE: NewsletterStyle = styleSchema.parse({
  mastheadImageUrl: "https://d3k81ch9hvuctc.cloudfront.net/company/Jchkiv/images/405af84f-b9e5-445e-86a4-68c2211e6876.png",
  mastheadLinkUrl: "https://www.starterstory.com/join",
  mastheadBackground: "#EBECFC",
});
const NEUTRAL_STYLE: NewsletterStyle = styleSchema.parse({});

const COURSE_HINT =
  "A bold linked-or-plain headline that leads with the money or the hook, then a 4 to 8 short-line teaser that ends with a link line to the piece (video or case study).";

/** Templates used when a format has none saved (keyed by lowercase format name). */
export const DEFAULT_TEMPLATES: Record<string, NewsletterTemplate> = {
  "sunday breakfast": {
    version: 1,
    style: STARTER_STORY_STYLE,
    // HubSpot account 20627419: "[TEMPLATE] Sunday Breakfast – Hub & Spoke (do
    // not send)", a copy of the Oct 11 2026 issue. Block ids read off that email.
    hubspot: {
      templateEmailId: "225070550319",
      blocks: {
        intro: "module_17900293533527",
        orange_juice: "module_17900290499731",
        coffee: "module_17900291783105",
        special: "module_17900294859938",
        eggs: "module_17900291707464",
        toast: "module_17900290992183",
        pancakes: "module_17900290904092",
        signoff: "module_17900290904092",
      },
      emailName: "{brand} | Newsletter | {Month} {D}",
    },
    sections: [
      s("intro", null, "'Hey!' then 3 to 8 short personal lines from Pat about his week, ending with 'Welcome to Sunday Breakfast!!' (or similar).", { story: "none" }),
      s("orange_juice", "The Orange Juice 🍊", `The week's flagship YouTube video: the newest one published that week. ${COURSE_HINT}`, { pillColor: "#fed7aa", story: "newest_video" }),
      s("coffee", "The Coffee ☕", `The week's second-newest video. ${COURSE_HINT}`, { pillColor: "#fae8ff", story: "newest_video" }),
      s("special", "The Special 🍽️", "The sponsored promo, or a lead magnet pitched like an ad when no sponsor is booked.", { kind: "sponsor", pillColor: "#fae8ff", boxColor: "#EBECFC" }),
      s("eggs", "The Eggs 🍳", `The week's newest case study; if there isn't one, another recently published video that still fits. ${COURSE_HINT}`, { pillColor: "#fef9c3", story: "case_study" }),
      s("toast", "The Toast 🍞", `Another of the week's case studies; else a recent video that still fits. ${COURSE_HINT}`, { pillColor: "#dcfce7", story: "case_study" }),
      s("pancakes", "The Pancakes 🥞", `Another case study or recent video. A "same guy as before ^^^" follow-up to an earlier course is fine when it's true. ${COURSE_HINT}`, { pillColor: "#e0f2fe", story: "case_study" }),
      s("signoff", null, "'That's it!', a one-line weekend wish, then 'Pat' and 'Founder, StarterStory.com' on their own lines. No footer.", { story: "none" }),
    ],
  },
  "daily seinfeld": {
    version: 1,
    style: { ...STARTER_STORY_STYLE, dividers: false },
    // HubSpot account 20627419: "[TEMPLATE] Daily Seinfeld – Hub & Spoke (do
    // not send)", a copy of the Oct 15 2026 issue. Block ids read off that email.
    hubspot: {
      templateEmailId: "225078360688",
      blocks: {
        read_time: "module_17873409641891",
        hook: "module_17913969457581",
        story: "module_17919070040741",
        pitch: "module_17872589671611",
      },
      emailName: "{brand} | Daily | {Mon}. {D}",
    },
    sections: [
      s("read_time", null, "Exactly 'Read Time: N sec.' (or 'Read Time: 1 min. N sec.') for the whole email at ~200 words per minute. Nothing else."),
      s("hook", null, "The opening: 2 to 6 short lines that set up the one story or observation (a founder, a message, a number, a contrarian claim)."),
      s("story", null, "The heart of it in short lines: the story and its one lesson (ship fast, simplicity wins, distribution matters…)."),
      s("pitch", null, "The pivot from the lesson to the offer from the editor's notes (or a CTA to the episode/case study when there is none), the CTA link, then '– Pat'. No footer."),
    ],
  },
  ...Object.fromEntries(
    ["how-to newsletter - futurepedia (pilot)", "how-to newsletter - skill leap (pilot)"].map((name) => [
      name,
      {
        version: 1 as const,
        style: NEUTRAL_STYLE,
        hubspot: null,
        sections: [
          s("intro", null, "2 to 4 short first-person lines in the channel voice, the signature on its own line, then a one-line teaser text link to the Free Resource offer."),
          s("article", null, "The article headline as an H2 (the how-to, benefit-first), the video thumbnail as a Markdown image, then the one-line concrete example."),
          s("why", null, "An H3 'Why [Tool] Works', a benefit-first line, then 3 to 5 ✅ bullets each led by a bolded action verb."),
          s("steps", "How We Did It", "The first half of the 4 to 6 numbered steps: one action each, action bolded, a concrete business impact, italic [Screenshot: …] placeholders.", { headingLevel: 3 }),
          s("free_resource", "Free Resource", "The offer: headline, 2 to 3 sentence body, 3 to 5 Key Takeaways bullets and the CTA link.", { kind: "sponsor", boxColor: "#f1f5f9" }),
          s("steps_continued", "How We Did It (continued)", "The rest of the numbered steps (continue the numbering), then the line [Watch The Full Video ->](VIDEO_URL).", { headingLevel: 3 }),
          s("use_cases", "Use Cases", "3 to 5 bullets: a fitting emoji, a bold role label, then the point.", { headingLevel: 3 }),
          s("bonus_tips", "Bonus Tips", "2 to 3 bullets: bold directive then explanation, at least one about scaling or saving time.", { headingLevel: 3 }),
        ],
      },
    ]),
  ),
};

/** The format's saved template, else its default, else null (free-form body). */
export function templateFor(formatName: string, saved: unknown): NewsletterTemplate | null {
  return parseNewsletterTemplate(saved) ?? DEFAULT_TEMPLATES[formatName.trim().toLowerCase()] ?? null;
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

// ── Shared email styles ─────────────────────────────────────────────────
// One style map for both renderers: renderEmailHtml (inline-CSS HTML for the
// email push; worker-side) and <EmailPreview> (React, in the browser). Keep
// every visual decision here so the preview and the sent email can't drift.

export type CssProps = Record<string, string | number>;

/** React-style CSS object → inline `style=""` text. Pure; exported for tests. */
export function cssText(css: CssProps): string {
  return Object.entries(css)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${typeof v === "number" && k !== "fontWeight" && k !== "lineHeight" ? `${v}px` : v}`)
    .join(";");
}

export function emailCss(st: NewsletterStyle) {
  return {
    page: { margin: 0, padding: 0, background: st.pageBackground } as CssProps,
    outer: { padding: "24px 12px", background: st.pageBackground } as CssProps,
    card: { width: "100%", maxWidth: 600, margin: "0 auto", background: st.contentBackground, borderRadius: 8 } as CssProps,
    inner: { padding: "28px 32px", fontFamily: st.fontFamily, color: st.textColor } as CssProps,
    mastheadWrap: { background: st.mastheadBackground ?? "transparent", borderRadius: 4, textAlign: "center", marginBottom: 20 } as CssProps,
    mastheadImg: { display: "block", width: "100%", maxWidth: "100%", height: "auto", border: 0 } as CssProps,
    pillWrap: { margin: "0 0 14px" } as CssProps,
    pill: (color: string): CssProps => ({ display: "inline-block", background: color, padding: 8, borderRadius: 4, fontSize: 20, fontWeight: "bold", lineHeight: 1.2, color: st.headingColor }),
    plainHeading: (level: 2 | 3): CssProps => ({ margin: "0 0 10px", fontSize: level === 2 ? 21 : 18, fontWeight: "bold", lineHeight: 1.3, color: st.headingColor }),
    box: (color: string): CssProps => ({ background: color, padding: "16px 18px", borderRadius: 6 }),
    divider: { border: "none", borderTop: "1px solid #e5e7eb", margin: "22px 0" } as CssProps,
    gap: { height: 8 } as CssProps,
    hint: { margin: "0 0 14px", fontSize: 15, lineHeight: 1.5, color: "#9ca3af", fontStyle: "italic" } as CssProps,
    tags: {
      p: { margin: "0 0 14px", fontSize: 16, lineHeight: 1.55, color: st.textColor },
      h1: { margin: "20px 0 10px", fontSize: 24, lineHeight: 1.3, color: st.headingColor },
      h2: { margin: "18px 0 10px", fontSize: 21, lineHeight: 1.3, color: st.headingColor },
      h3: { margin: "16px 0 8px", fontSize: 18, lineHeight: 1.3, color: st.headingColor },
      ul: { margin: "0 0 14px", paddingLeft: 22, color: st.textColor, listStyleType: "disc" },
      ol: { margin: "0 0 14px", paddingLeft: 22, color: st.textColor, listStyleType: "decimal" },
      li: { margin: "0 0 6px", fontSize: 16, lineHeight: 1.5 },
      a: { color: st.linkColor, textDecoration: "underline" },
      img: { display: "block", width: "100%", maxWidth: "100%", height: "auto", border: 0, borderRadius: 6, margin: "6px 0 14px" },
      blockquote: { margin: "0 0 14px", paddingLeft: 12, borderLeft: "3px solid #e5e7eb", color: st.textColor },
      hr: { border: "none", borderTop: "1px solid #e5e7eb", margin: "20px 0" },
      code: { fontFamily: "Menlo, monospace", fontSize: 14, background: "#f4f4f5", padding: "1px 4px", borderRadius: 3 },
    } satisfies Record<string, CssProps>,
  };
}

/**
 * The Markdown for each mapped email-tool block: every section mapped to the
 * block, in template order, joined by a blank line (the sponsor section uses
 * the promo copy when there is one). Headings are not included — the email
 * tool's template carries them (Sunday Breakfast's course labels). Pure.
 */
export function blockMarkdown(
  template: NewsletterTemplate,
  sections: NewsletterSection[],
  sponsor: ComposeSponsor | null,
): Record<string, string> {
  if (!template.hubspot) return {};
  const byKey = new Map(sections.map((x) => [x.key, x.markdown]));
  const out: Record<string, string> = {};
  for (const sec of template.sections) {
    const block = template.hubspot.blocks[sec.key];
    if (!block) continue;
    const md =
      sec.kind === "sponsor" && sponsor?.copy?.trim()
        ? sponsorBlock(sponsor.copy, sponsor.landingUrl)
        : (byKey.get(sec.key) ?? "").trim();
    if (!md) continue;
    out[block] = out[block] ? `${out[block]}\n\n${md}` : md;
  }
  return out;
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
