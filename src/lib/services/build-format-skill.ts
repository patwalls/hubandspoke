// "Build with AI" for a format Skill: the operator answers a few plain
// questions (how captions are formatted, what to look for in the video,
// the hook, other rules…), optionally drops screenshots of example posts,
// and Haiku writes the whole Skill as plain sentences — no markdown, since
// the people editing it don't read markdown. On-demand only (one call per
// click, POST /api/formats/build-skill); nothing is saved here — the
// result lands in the Skill box for the operator to edit and save.
//
// Mirrors derivative-hook.ts: one pinned tool, fail-soft `{ ok: false }`.
import Anthropic from "@anthropic-ai/sdk";
import type { FormatFamily } from "@/lib/format-kinds";

const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 1500;

export interface SkillAnswer {
  question: string;
  answer: string;
}

export interface BuildFormatSkillArgs {
  family: FormatFamily;
  /** "Instagram Reel", "X carousel / image post"… */
  kindLabel: string;
  formatName?: string | null;
  answers: SkillAnswer[];
  /** The Skill already in the box — rewritten, not discarded. */
  existing?: string | null;
  images?: { mediaType: string; dataB64: string }[];
  /** "Upload examples": the screenshots ARE the brief — work out the
   *  whole Skill from them. */
  fromExamples?: boolean;
  client?: Anthropic;
}

export type BuildFormatSkillResult =
  | { ok: true; skill: string; suggestedName: string | null }
  | { ok: false; failure: { reason: "nothing-to-go-on" } | { reason: "llm-empty" } | { reason: "llm-error"; message: string } };

const FAMILY_CONTEXT: Record<FormatFamily, string> = {
  clip: "a short video clip cut from a longer pillar video (the AI picks the moment, writes an on-screen hook, and writes the post caption)",
  design: "a carousel or image post made from a pillar video (the AI writes the slides/image text and the post caption)",
  pillar: "a pillar: the original long-form video that clips and posts are made from (this Skill gives context to everything made from it)",
  newsletter: "an email newsletter edition",
};

const SYSTEM_PROMPT = `You write the "Skill" for a content format: the instructions an AI follows every time it makes a post in this format. The team edits it in a plain text box and does not know markdown.

WRITE
- Plain sentences in short paragraphs, one topic per paragraph (which moments from the video fit the format and which don't; how the caption is written; things to always or never do). Skip topics the team gave nothing for unless the screenshots clearly show it.
- Specific and concrete, in the team's own words where they gave them. Keep every rule they stated — never soften, drop or contradict one.
- If there is an existing Skill, rewrite it to include the new answers; keep everything from it that the answers don't change.
- If screenshots are attached, describe what they show that matters (structure, caption shape, on-screen text style) as rules.

NEVER
- No markdown: no #, no bullets, no bold, no tables, no code blocks.
- No placeholders like [this] or "e.g." — only real instructions.
- Don't invent facts about the brand. Don't add rules the team didn't ask for beyond what the screenshots show.
- Leave out what other tools own: exact hook wording, clip length, caption/text styling, fonts, slide layout or per-slide copy, and CTA links.

Always call return_skill exactly once.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "return_skill",
    description: "Return the finished Skill text and, if none was given, a short name for the format.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill: { type: "string", description: "The whole Skill, plain sentences in short paragraphs separated by blank lines. No markdown." },
        suggested_name: { type: "string", description: "A short, specific format name (2–5 words), e.g. \"Tech Stack Reveal\". Empty string if a name was given." },
      },
      required: ["skill", "suggested_name"],
    },
  },
];

/** The user turn's text. Pure — exported for tests. */
export function buildSkillUserText(args: Omit<BuildFormatSkillArgs, "client" | "images"> & { imageCount: number }): string {
  // (fromExamples rides along in args.)
  const answered = args.answers.filter((a) => a.answer.trim());
  const lines = [
    `Format type: ${args.kindLabel} — ${FAMILY_CONTEXT[args.family]}.`,
    args.formatName?.trim() ? `Format name: ${args.formatName.trim()}` : "Format name: (none yet — suggest one)",
    "",
  ];
  if (args.existing?.trim()) {
    lines.push("Existing Skill (rewrite it; keep what the answers don't change):", args.existing.trim(), "");
  }
  if (answered.length) {
    lines.push("The team's answers:");
    for (const a of answered) lines.push(`Q: ${a.question}`, `A: ${a.answer.trim()}`, "");
  }
  if (args.imageCount > 0) {
    lines.push(`${args.imageCount} screenshot${args.imageCount === 1 ? "" : "s"} of example posts attached below.`);
    if (args.fromExamples) {
      lines.push(
        "The team didn't answer questions — the screenshots ARE the brief. Study them closely and write the whole Skill from what they have in common: what kind of moment or subject each post is built on, how the caption is written (voice, length, structure, emoji/hashtag use, how it ends), and the patterns to always or never follow.",
      );
    }
  }
  return lines.join("\n").trim();
}

/** Strip markdown the model slipped in anyway (structural only: heading
 *  marks, bullet marks, bold). */
export function plainSkillText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*•]\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function buildFormatSkill(args: BuildFormatSkillArgs): Promise<BuildFormatSkillResult> {
  const images = args.images ?? [];
  const hasAnswers = args.answers.some((a) => a.answer.trim());
  if (!hasAnswers && images.length === 0 && !args.existing?.trim()) {
    return { ok: false, failure: { reason: "nothing-to-go-on" } };
  }
  const client = args.client ?? new Anthropic();
  const text = buildSkillUserText({ ...args, imageCount: images.length });
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text },
    ...images.map(
      (img): Anthropic.ImageBlockParam => ({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: img.dataB64,
        },
      }),
    ),
  ];
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "return_skill" },
      messages: [{ role: "user", content }],
    });
    const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const input = (block?.input ?? {}) as { skill?: string; suggested_name?: string };
    const skill = plainSkillText(input.skill ?? "");
    if (!skill) return { ok: false, failure: { reason: "llm-empty" } };
    const name = (input.suggested_name ?? "").trim();
    return { ok: true, skill, suggestedName: name || null };
  } catch (err) {
    return { ok: false, failure: { reason: "llm-error", message: err instanceof Error ? err.message : String(err) } };
  }
}
