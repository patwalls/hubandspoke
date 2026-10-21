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
});

export const newsletterTemplateSchema = z
  .object({
    version: z.literal(1),
    sections: z.array(sectionSchema).min(1).max(20),
  })
  .refine((t) => new Set(t.sections.map((s) => s.key)).size === t.sections.length, "section keys must be unique")
  .refine((t) => t.sections.filter((s) => s.kind === "sponsor").length <= 1, "at most one sponsor section");

export type NewsletterTemplate = z.infer<typeof newsletterTemplateSchema>;
export type NewsletterTemplateSection = z.infer<typeof sectionSchema>;

/** One drafted section of an issue (stored on newsletter_drafts.sections). */
export interface NewsletterSection {
  key: string;
  markdown: string;
}

export function parseNewsletterTemplate(raw: unknown): NewsletterTemplate | null {
  const r = newsletterTemplateSchema.safeParse(raw);
  return r.success ? r.data : null;
}

const s = (
  key: string,
  heading: string | null,
  hint: string,
  extra: Partial<Pick<NewsletterTemplateSection, "headingLevel" | "kind">> = {},
): NewsletterTemplateSection => ({ key, heading, hint, headingLevel: extra.headingLevel ?? 2, kind: extra.kind ?? "text" });

const COURSE_HINT =
  "A bold linked-or-plain headline that leads with the money or the hook, then a 4 to 8 short-line teaser that ends with a link line to the piece (video or case study).";

/** Templates used when a format has none saved (keyed by lowercase format name). */
export const DEFAULT_TEMPLATES: Record<string, NewsletterTemplate> = {
  "sunday breakfast": {
    version: 1,
    sections: [
      s("intro", null, "'Hey!' then 3 to 8 short personal lines from Pat about his week, ending with 'Welcome to Sunday Breakfast!!' (or similar)."),
      s("orange_juice", "The Orange Juice 🍊", `The week's flagship YouTube video. ${COURSE_HINT}`),
      s("coffee", "The Coffee ☕", `A second video or a strong case study. ${COURSE_HINT}`),
      s("special", "The Special 🍽️", "The sponsored promo, or a lead magnet pitched like an ad when no sponsor is booked.", { kind: "sponsor" }),
      s("eggs", "The Eggs 🍳", `A case study. ${COURSE_HINT}`),
      s("toast", "The Toast 🥪", `A case study or video. ${COURSE_HINT}`),
      s("pancakes", "The Pancakes 🥞", `A case study or video. ${COURSE_HINT}`),
      s("signoff", null, "'That's it!', a one-line weekend wish, then 'Pat' and 'Founder, StarterStory.com' on their own lines. No footer."),
    ],
  },
  "daily seinfeld": {
    version: 1,
    sections: [
      s("story", null, "'Read time: N sec.' on the first line, then the one story or observation and its lesson, in short lines."),
      s("pitch", null, "The pivot from the lesson to the offer from the editor's notes (or a CTA to the episode/case study when there is none), the CTA link, then '– Pat'. No footer."),
    ],
  },
  ...Object.fromEntries(
    ["how-to newsletter - futurepedia (pilot)", "how-to newsletter - skill leap (pilot)"].map((name) => [
      name,
      {
        version: 1 as const,
        sections: [
          s("intro", null, "2 to 4 short first-person lines in the channel voice, the signature on its own line, then a one-line teaser text link to the Free Resource offer."),
          s("article", null, "The article headline as an H2 (the how-to, benefit-first), the video thumbnail as a Markdown image, then the one-line concrete example."),
          s("why", null, "An H3 'Why [Tool] Works', a benefit-first line, then 3 to 5 ✅ bullets each led by a bolded action verb."),
          s("steps", "How We Did It", "The first half of the 4 to 6 numbered steps: one action each, action bolded, a concrete business impact, italic [Screenshot: …] placeholders.", { headingLevel: 3 }),
          s("free_resource", "Free Resource", "The offer: headline, 2 to 3 sentence body, 3 to 5 Key Takeaways bullets and the CTA link.", { kind: "sponsor" }),
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
