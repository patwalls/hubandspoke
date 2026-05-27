// Pure prompt-assembly helpers for the format Skill drafter
// (`draft-skill/route.ts`). Kept in a side-effect-free module so the
// branchy fork-mode text assembly can be unit-tested without spinning up
// the route, a DB connection, or an Anthropic client.

const MAX_PARENT_SKILL_CHARS = 6000;
const MAX_CONTENT_BODY_CHARS = 2000;

export interface ForkItemContext {
  title: string | null;
  postType: string | null;
  format: string | null;
  contentBody: string | null;
}

export interface ForkPromptInput {
  brand: string;
  /** Display name of the format being forked. */
  parentFormatName: string;
  /** The parent format's Skill markdown (the starting point). */
  parentInstructions: string | null;
  /** Operator's chosen name for the new, narrower format. */
  newName: string;
  /** Optional steering note: what makes this variant more specific. */
  steeringNote?: string | null;
  /** The example piece of content this fork should specialize for. */
  item?: ForkItemContext | null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated)`;
}

/**
 * Build the user-message text for a FORK request. Unlike the from-scratch
 * path, this hands Haiku the parent's existing Skill plus a concrete example
 * piece of content and asks it to *narrow* rather than invent. The
 * required-sections contract still lives in the route's SYSTEM_PROMPT — this
 * only supplies the fork-specific framing and grounding.
 */
export function buildForkUserText(input: ForkPromptInput): string {
  const note = (input.steeringNote ?? "").trim();
  const parentSkill = (input.parentInstructions ?? "").trim();
  const item = input.item;

  const lines: string[] = [
    `This is a FORK of an existing format. Do NOT write a new format from scratch — specialize the parent below.`,
    ``,
    `Brand: ${input.brand}`,
    `The operator has named this fork: "${input.newName}". Tailor the Skill to that name.`,
    ``,
    `Parent format being forked: "${input.parentFormatName}"`,
    `Parent format Skill — your starting point. Keep its section headings, structure, and brand voice:`,
    `<<<PARENT_SKILL`,
    parentSkill.length > 0
      ? truncate(parentSkill, MAX_PARENT_SKILL_CHARS)
      : `(The parent has no Skill recorded yet. Infer a sensible base from the parent name and the example content below.)`,
    `PARENT_SKILL`,
    ``,
    `What makes this fork more specific (operator's steering note):`,
    note.length > 0
      ? note
      : `(None given — infer the narrower angle from the example piece of content below.)`,
  ];

  if (item) {
    lines.push(
      ``,
      `Example piece of content this fork should specialize for:`,
      `- Title: ${item.title?.trim() || "(none)"}`,
      `- Post type: ${item.postType?.trim() || "(none)"}`,
      `- Currently tagged format: ${item.format?.trim() || "(none)"}`,
      `- Body / caption:`,
      item.contentBody && item.contentBody.trim().length > 0
        ? truncate(item.contentBody.trim(), MAX_CONTENT_BODY_CHARS)
        : `(no body text captured)`,
    );
  }

  lines.push(
    ``,
    `Your task: produce a SPECIALIZED version of the parent Skill via submit_format_draft.`,
    `- Keep every required section heading from the parent.`,
    `- NARROW it: tighten Clip guidance, Hook style, Anti-patterns, and Avoid to this more-specific case. Drop guidance that no longer applies; add specifics that do.`,
    `- Preserve the brand voice and any Descript / Cross Post placeholders the parent uses.`,
    `- This is a narrower child of the parent — do not broaden the scope.`,
  );

  return lines.join("\n");
}
