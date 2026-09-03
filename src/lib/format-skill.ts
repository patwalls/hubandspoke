/**
 * The canonical structure for a format's prompt ("skill").
 *
 * Each format's `instructions` text is treated like a Claude Skill: a
 * self-contained markdown recipe that the dispatcher agent reads when
 * producing content in that format. Sections are also human-readable
 * documentation for anyone editing the format.
 */
export const DEFAULT_FORMAT_SKILL_TEMPLATE = `## Post formatting
Describe how posts in this format are structured. e.g. "This is a one-liner tweet + vertical video. The hook text IS the entire post — no caption body needed."

## Caption formatting
- [Add caption style rules. e.g. Don't use em dashes.]
- [e.g. For bullet points, use >]

## Descript Clip & Pack Info
The layout pack is chosen in the format settings ("Descript layout pack" dropdown) — do NOT paste pack URLs here; the prompt gets a validated apply-by-id instruction automatically. The pack handles [e.g. vertical 9:16 framing, the hook-text track, and the captions slot] — use it instead of manually setting aspect ratio or adding caption tracks.

Set the hook text track at the top of the composition to: "{{hook}}". Replace whatever placeholder or default text the layout pack provides — do not append; replace.

Inside the composition, mark filler words ("um", "uh", "like" when used as filler, "you know", "I mean", false starts, repeated words, and long silences > 400ms) as IGNORED — use Descript's ignore / strike-through feature so the words remain visible in the script crossed out but are skipped during playback. DO NOT DELETE these words.

Do not add transitions, effects, music, or title cards beyond what the layout pack already includes. Do not re-order anything. Do not rewrite the transcript.

## Cross Post Rules
- [e.g. Instagram, TikTok and YT Shorts should be vertical]
- [e.g. X, Threads, LinkedIn should be horizontal — apply these changes in Descript underlord]
- [e.g. For X cross-posts: use the source's on-screen hook as the tweet body, verbatim. No thread, no bullet points, no CTA, no link. One line, that's it.]

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
`;

const TEMPLATE_HEADINGS = [
  "## Post formatting",
  "## Caption formatting",
  "## Descript Clip & Pack Info",
  "## Cross Post Rules",
  "## Clip Idea Generation",
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
/** The registry row shape the pack instruction is built from — matches
 *  `descript_layout_packs` columns. */
export interface DescriptLayoutPackRef {
  name: string;
  descriptId: string;
  pageUrl: string | null;
}

/**
 * The canonical Underlord instruction for applying a layout pack. Two
 * hard-won rules baked in (2026-09-03):
 *  - Reference the pack by NAME AND ID, and tell the agent its
 *    `query_layout_packs` tool may lie (it returns an empty list inside
 *    API-created projects) — without the "do NOT stop there" the agent
 *    gives up and skips framing/hook/captions.
 *  - Declare that this instruction supersedes any pack URL still lingering
 *    in Skill prose, so a stale hand-written reference can't fight it.
 */
export function buildLayoutPackInstruction(pack: DescriptLayoutPackRef): string {
  const page = pack.pageUrl ? ` (page: ${pack.pageUrl})` : "";
  return (
    `Apply the layout pack named "${pack.name}" — its id is ${pack.descriptId}${page}. ` +
    `Your query_layout_packs tool may return an empty list — do NOT stop there; ` +
    `apply the pack directly by its id/URL with whatever layout tool accepts an identifier. ` +
    `This instruction supersedes any other layout-pack link or name mentioned elsewhere in this prompt.`
  );
}

/**
 * Splice the canonical pack instruction into a format Skill so every
 * downstream consumer of `extractDescriptSection` picks it up. Inserted
 * immediately below the `### Descript Clip & Pack Info` heading; when the
 * Skill has no such heading (or is empty), a new section is appended so
 * selecting a pack in the dropdown is sufficient to activate the Descript
 * branch. No pack → input returned unchanged.
 */
export function injectLayoutPackInstruction(
  instructions: string | null,
  pack: DescriptLayoutPackRef | null | undefined,
): string | null {
  if (!pack) return instructions;
  const instruction = buildLayoutPackInstruction(pack);
  const skill = instructions ?? "";
  const match = DESCRIPT_SECTION_HEADING.exec(skill);
  if (!match) {
    return `${skill.trimEnd()}\n\n## Descript Clip & Pack Info\n\n${instruction}\n`.trimStart();
  }
  const insertAt = match.index + match[0].length;
  return `${skill.slice(0, insertAt)}\n\n${instruction}\n${skill.slice(insertAt)}`;
}

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
const CLIP_COUNT_FENCE = /```clip-count\s*\n(\d+)\s*\n```/i;

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
/**
 * Pull the optional `clip-count` fenced block out of a clip-idea section.
 * When present, the service caps the number of clip ideas inserted for this
 * format to the given integer (top N by estimated views). E.g.:
 *
 *   ```clip-count
 *   1
 *   ```
 *
 * Returns `null` when the block is absent (no cap — all eligible sections
 * produce a clip idea). Returns `null` for invalid values (< 1).
 */
export function extractClipCount(clipIdeaSection: string): number | null {
  const match = CLIP_COUNT_FENCE.exec(clipIdeaSection);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

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
