// Guidance for writing a format Skill in plain sentences — no markdown.
// Each family gets "Build with AI" questions (answered in plain words, then
// written up by build-format-skill.ts) and a worked example shown as the
// empty box's placeholder. The Skill stays one free-text field; the Draft
// Algorithm and clip-idea agents read the whole thing. Repost rules are
// optional here — the Draft Algorithm has built-in per-platform defaults
// (draft-algorithm/cross-post-defaults.ts).
import type { FormatFamily } from "@/lib/format-kinds";

export interface SkillQuestion {
  id: string;
  question: string;
  placeholder: string;
}

// Only what the Skill actually steers. Left out on purpose, because
// something else owns it:
//  - the hook text: written per clip by AI from the format's top hooks,
//    editable in the clip editor; its look lives in the clip look;
//  - clip length: sections are 25–95s by design and trimmed in the editor;
//  - slides (count, layout, what each box says): the design template's
//    slots and hints, plus the format's past posts;
//  - the CTA link: a separate step (format CTA setting / tracked link).
const CAPTION: SkillQuestion = {
  id: "caption",
  question: "How should the caption be written?",
  placeholder: "e.g. Casual and first person, like texting a founder friend. Words like \"bootstrapped\" are good; never \"hustle\".",
};
const RULES: SkillQuestion = {
  id: "rules",
  question: "Anything to always or never do?",
  placeholder: "e.g. Always mention the revenue number. Only feature tools, never people. No em dashes.",
};

/** "Build with AI" questions, per family. All optional. */
export const SKILL_QUESTIONS: Record<FormatFamily, SkillQuestion[]> = {
  clip: [
    {
      id: "moments",
      question: "What kinds of moments should this format be made from, and what doesn't fit?",
      placeholder: "e.g. The founder revealing a surprising number or a strong opinion. Skip small talk, sponsor reads and intros.",
    },
    CAPTION,
    RULES,
  ],
  design: [CAPTION, RULES],
  pillar: [
    { id: "what", question: "What is the show?", placeholder: "e.g. A 20-minute interview where a founder breaks down how they built a $1M/yr business." },
    { id: "audience", question: "Who is it for?", placeholder: "e.g. Aspiring founders, 20–35." },
    { id: "voice", question: "How does the brand sound?", placeholder: "e.g. Direct, numbers-first, no hype." },
  ],
  newsletter: [
    { id: "sections", question: "What's in each edition?", placeholder: "e.g. A 2–3 sentence intro, the breakdown, then links and a sign-off." },
    { id: "tone", question: "What's the tone?", placeholder: "e.g. Friendly and direct." },
    { id: "subject", question: "How are subject lines written?", placeholder: "e.g. Under 50 characters, lead with the number." },
  ],
};

/** Shown in the builder: what NOT to put in the Skill, and where it's set. */
export const SET_ELSEWHERE: Partial<Record<FormatFamily, string>> = {
  clip: "Set elsewhere, no need to add here: the hook (AI writes one per clip, edit it in the clip editor), caption style, fonts and framing (the clip look), clip length (trim in the editor) and the CTA link (format settings).",
  design: "Set elsewhere, no need to add here: the slides, layout, fonts and what each text box says (the design template) and the CTA link (format settings).",
};

export const SKILL_EXAMPLE: Record<FormatFamily, string> = {
  clip: [
    "Example:",
    "Make these from moments where the founder reveals a surprising number or a strong opinion. Skip small talk, sponsor reads and the intro.",
    "Captions are casual and first person, like texting a founder friend.",
    "Always mention the revenue number. No em dashes.",
  ].join("\n\n"),
  design: [
    "Example:",
    "Captions are 2–3 sentences, first person, and lead with the result.",
    "Only feature tools, never people. Always include the monthly revenue. No em dashes.",
  ].join("\n\n"),
  pillar: [
    "Example:",
    "This show is a 20-minute interview where a founder breaks down how they built a $1M/yr business.",
    "It's for aspiring founders, 20–35. The voice is direct and numbers-first, no hype.",
  ].join("\n\n"),
  newsletter: [
    "Example:",
    "Each edition opens with 2–3 sentences, then the breakdown, then links and a sign-off.",
    "The tone is friendly and direct. Subject lines should be under 50 characters and lead with the number.",
  ].join("\n\n"),
};
