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

## Clip Idea Generation
The Splice agent reads this section when generating clip ideas for this format. Describe:

- **Hook style** — what the hook IS for this format. (Narrator overlay in editorial voice? Third-person framing tweet? Founder quote pulled from the transcript?) Show 2–3 brand examples if you can.
- **Target runtime** — clip length sweet spot, e.g. 30–60s for Reels, 20–40s for X Quotables.
- **Anti-patterns** — format-specific things the hook must NEVER do.
- **Output extras** (optional) — for formats that need more than just a hook. Declare via a fenced code block labeled \`extras-schema\` (JSON, valid JSON Schema fragment). Each property becomes a required field on every generated idea. Example for an X-Quotables-style format:

\`\`\`extras-schema
{
  "quotables": {
    "type": "array",
    "items": { "type": "string" },
    "minItems": 3,
    "maxItems": 3,
    "description": "Three verbatim transcript pulls, each one paragraph long, each delivering a discrete punch. Pulls must come from inside [startSec, endSec]."
  }
}
\`\`\`

If this section is absent, the agent falls back to the default Reels-style behavior (narrator overlay hook, 30–60s clip, no extras).

## Descript Clip & Pack Info
How Descript Underlord should edit a clip in this format. Include: layout pack URL (if any), hook text placeholder, filler-word marking rules, and anything it must NOT do.

## Cross Post Rules
Platform-by-platform caption and framing rules when repurposing clips from this format. One rule per platform.
`;

const TEMPLATE_HEADINGS = [
  "## What this format is",
  "## Why it works",
  "## Clip guidance",
  "## Avoid",
  "## Clip Idea Generation",
  "## Descript Clip & Pack Info",
  "## Cross Post Rules",
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
const CLIP_IDEA_SECTION_HEADING = /^[ \t]*##{1,2}[ \t]+Clip Idea Generation[ \t]*$/im;
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
 * Pull the `### Cross Post Rules` section out of a format Skill. The
 * section is the shared source of truth for cross-post / repost behavior;
 * BOTH consumers read it and apply the rules relevant to them:
 *
 *   - Descript Underlord (`descript-derivative-create` task) reads it for
 *     framing rules — "Twitter and LinkedIn should be horizontal, IG /
 *     TikTok / YT Shorts vertical." Bullets that don't mention framing
 *     are ignored.
 *
 *   - The Draft Algorithm (`run.ts` → `generateDraft`) reads it for
 *     caption-shape rules — "For X cross-posts: use the on-screen hook
 *     as the tweet body, verbatim. No thread, no CTA, no link." Bullets
 *     that don't mention captions are ignored.
 *
 * Both consumers are agentic and can identify the bullets that apply.
 * One section keeps the user's authoring mental model intact ("here are
 * the rules for cross-posting from this format") and avoids forcing them
 * to split content into parallel headings.
 *
 * Returns null when the section is missing — both consumers then fall
 * back to their default behavior (Underlord: byte-identical duplicate;
 * Draft Algorithm: exemplar-driven generation).
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
 * Pull the `## Clip Idea Generation` section out of a format Skill. The
 * Splice clip-idea agent reads this section verbatim to learn the format's
 * hook style, target runtime, anti-patterns, and (optionally) the structured
 * `extras-schema` for any per-idea fields beyond the core hook/section
 * shape — e.g. `quotables: string[3]` for the X Quotables format.
 *
 * Returns `null` when the section is missing — the agent then falls back to
 * its hardcoded default block (current Reels-style narrator-overlay hook,
 * 30-60s runtime, no extras). This back-compat path keeps the original
 * `Repackage Section w/ Hook` format working when its skill hasn't yet
 * been extended with the new section.
 */
export function extractClipIdeaSection(skill: string): string | null {
  const match = CLIP_IDEA_SECTION_HEADING.exec(skill);
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

const EXTRAS_SCHEMA_FENCE = /```extras-schema\s*\n([\s\S]*?)\n```/i;

/**
 * Pull the optional `extras-schema` fenced block out of a clip-idea section.
 * The block contents must be a JSON Schema fragment whose keys are added as
 * required properties on the agent's `extras` tool input. E.g.:
 *
 *   ```extras-schema
 *   { "quotables": { "type": "array", "items": { "type": "string" },
 *                    "minItems": 3, "maxItems": 3 } }
 *   ```
 *
 * Returns the parsed JSON object on success, `null` if no block exists OR
 * the JSON is invalid (the agent then runs without extras — fail-soft so a
 * typo in the skill doesn't take down generation entirely; the failure is
 * surfaced via the `error` callback when one is provided).
 */
export function extractExtrasSchema(
  clipIdeaSection: string,
  onError?: (message: string) => void
): Record<string, unknown> | null {
  const match = EXTRAS_SCHEMA_FENCE.exec(clipIdeaSection);
  if (!match) return null;
  const body = match[1].trim();
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      onError?.(
        "extras-schema block must be a JSON object whose keys are field names"
      );
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    onError?.(
      `extras-schema JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
