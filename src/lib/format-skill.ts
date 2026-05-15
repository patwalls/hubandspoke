/**
 * The canonical structure for a format's prompt ("skill").
 *
 * Each format's `instructions` text is treated like a Claude Skill: a
 * self-contained markdown recipe that the dispatcher agent reads when
 * producing content in that format. The four sections below are the
 * shape the agent looks for. The text is also what ships into Asana
 * tasks, so sections double as human-readable documentation.
 */
export const DEFAULT_FORMAT_SKILL_TEMPLATE = `## What this format is
Short one-liner. e.g. Vertical 30–60s highlight clip for Instagram Reels.

## Why it works
What makes this format hit. e.g. Strong hook in the first 3s, payoff by 15s. Audience gets a tactical insight without watching the full pillar.

## Clip guidance
How to pick and frame the moment. e.g. Look for a single strong quote, a surprising reveal, or a tactical tip. Start on a clean sentence boundary. End on a thought-ending beat. Target length 30–60 seconds.

## Avoid
What not to do. e.g. No filler intros. No "so yeah" tail-offs. Skip moments where the speaker is reading from a doc.
`;

const TEMPLATE_HEADINGS = [
  "## What this format is",
  "## Why it works",
  "## Clip guidance",
  "## Avoid",
];

/**
 * If the existing prompt is empty, replace it with the template.
 * If it's non-empty, append any template headings it's missing, so
 * users can opt in incrementally without losing their existing text.
 */
export function applyStarterTemplate(existing: string): string {
  const trimmed = existing.trim();
  if (!trimmed) return DEFAULT_FORMAT_SKILL_TEMPLATE;
  const missing = TEMPLATE_HEADINGS.filter(
    (h) => !trimmed.toLowerCase().includes(h.toLowerCase())
  );
  if (missing.length === 0) return existing;
  const appended = missing
    .map((h) => {
      const body = DEFAULT_FORMAT_SKILL_TEMPLATE.split(h)[1]?.split("## ")[0] ?? "";
      return `${h}\n${body.trim()}\n`;
    })
    .join("\n");
  return `${existing.trimEnd()}\n\n${appended}`;
}

const DESCRIPT_SECTION_HEADING = /^[ \t]*##{1,2}[ \t]+Descript Clip & Pack Info[ \t]*$/im;
const CROSS_POST_RULES_HEADING = /^[ \t]*##{1,2}[ \t]+Cross Post Rules[ \t]*$/im;
const CROSS_POST_CAPTION_RULES_HEADING = /^[ \t]*##{1,2}[ \t]+Cross Post Caption Rules[ \t]*$/im;
const ANY_HEADING_AT_LEVEL_OR_HIGHER = /^[ \t]*##{0,2}[ \t]+\S/m;

/**
 * Pull the operational Descript section out of a format Skill so the
 * Descript Underlord agent receives only what it cares about (layout-
 * pack URL, hook-track instruction, filler-word marking) — NOT the
 * editorial sections meant for Claude (`## Hook`, `## Clip guidance`,
 * `## Avoid`, etc.).
 *
 * Returns the body under the first `### Descript Clip & Pack Info`
 * heading (accepts `##` h2 or `###` h3, case-insensitive), up to but
 * not including the next heading. Falls back to the whole input when
 * no such heading exists — back-compat for formats whose Skill hasn't
 * been re-organized into sections yet (graceful degradation, never
 * blocks a clip from being made).
 */
export function extractDescriptSection(skill: string): string {
  const match = DESCRIPT_SECTION_HEADING.exec(skill);
  if (!match) return skill;
  const afterHeadingStart = match.index + match[0].length;
  const remainder = skill.slice(afterHeadingStart);
  const nextHeading = ANY_HEADING_AT_LEVEL_OR_HIGHER.exec(remainder);
  const section = nextHeading
    ? remainder.slice(0, nextHeading.index)
    : remainder;
  return section.trim();
}

/**
 * Pull the operational Cross Post Rules section out of a format Skill.
 * Used by the cross-post / repost Descript composition copy flow to tell
 * Underlord how to adapt the duplicate for the target platform (e.g.
 * "Twitter and LinkedIn should be horizontal, IG / TikTok / YT Shorts
 * vertical"). Returns null when the Skill has no such section — the
 * derivative-create task then falls back to a vanilla byte-identical
 * duplicate.
 */
export function extractCrossPostRulesSection(skill: string): string | null {
  const match = CROSS_POST_RULES_HEADING.exec(skill);
  if (!match) return null;
  const afterHeadingStart = match.index + match[0].length;
  const remainder = skill.slice(afterHeadingStart);
  const nextHeading = ANY_HEADING_AT_LEVEL_OR_HIGHER.exec(remainder);
  const section = nextHeading
    ? remainder.slice(0, nextHeading.index)
    : remainder;
  const trimmed = section.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pull the operational Cross Post Caption Rules section out of a format
 * Skill. This is the EDITORIAL counterpart to `### Cross Post Rules` —
 * the latter steers Descript Underlord on framing/aspect; this one steers
 * the Draft Algorithm on caption shape (e.g. "for X, use the on-screen
 * hook verbatim as the body, no thread, no CTA"). Returns null when
 * missing — the draft algorithm then falls back to exemplar-driven
 * generation (which can blow up captions when the format's top performer
 * is a long thread, see the 231K-view "phone until noon" exemplar).
 */
export function extractCrossPostCaptionRulesSection(
  skill: string,
): string | null {
  const match = CROSS_POST_CAPTION_RULES_HEADING.exec(skill);
  if (!match) return null;
  const afterHeadingStart = match.index + match[0].length;
  const remainder = skill.slice(afterHeadingStart);
  const nextHeading = ANY_HEADING_AT_LEVEL_OR_HIGHER.exec(remainder);
  const section = nextHeading
    ? remainder.slice(0, nextHeading.index)
    : remainder;
  const trimmed = section.trim();
  return trimmed.length > 0 ? trimmed : null;
}
