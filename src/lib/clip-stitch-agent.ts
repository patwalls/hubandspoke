import Anthropic from "@anthropic-ai/sdk";
import { MAX_SUPPORTING_MOMENTS, SUPPORTING_ROLES } from "./clip-stitch";

/**
 * Clip stitching M3: "Lines to stitch in" for ONE section detected before
 * section-picker v2, on demand (`clip-section-stitch` task), same rules as
 * the v2 picker. Quotes are untrusted: the caller runs them through
 * `locateSupportingMoments`.
 */
const MODEL = "claude-haiku-5-5";
/** Keeps one call bounded (~50k tokens) on the longest podcasts. */
const TRANSCRIPT_CHAR_BUDGET = 200_000;

const SYSTEM_PROMPT = `You help a video editor build a short clip. The clip is one section of a long video. Editors often stitch one to three short lines from ELSEWHERE in the video into the clip: the setup the payoff depends on, the concrete number or result that proves it, the demo step it skips over, the punchline that lands it.

Name 0–${MAX_SUPPORTING_MOMENTS} such lines for this section.

Rules:
- OUTSIDE THE SECTION. Each line must come from before the section's start or after its end — never from inside it.
- VERBATIM. Copy ≥ 6 consecutive words exactly as they appear in the transcript. No paraphrase, no ellipses, no [MM:SS] stamps or speaker names.
- SHORT. One or two cues — a line, not a passage.
- EARNED. Only a line that makes THIS clip clearer or stronger when spliced in. An empty list is the right answer when the section stands alone — never pad.
- role: "setup" (context the payoff needs), "detail" (a number, step, or example that backs it up), or "payoff" (the result or punchline that lands it).
- why: one short sentence an editor reads to decide whether to add it.

Never respond with plain text. Always call suggest_supporting_quotes exactly once.`;

const TOOL: Anthropic.Tool = {
  name: "suggest_supporting_quotes",
  description: `Return 0-${MAX_SUPPORTING_MOMENTS} lines from outside the section that an editor would stitch into the clip.`,
  input_schema: {
    type: "object" as const,
    properties: {
      supportingQuotes: {
        type: "array",
        maxItems: MAX_SUPPORTING_MOMENTS,
        items: {
          type: "object",
          properties: {
            quote: { type: "string", description: "≥ 6 consecutive words copied verbatim from the transcript." },
            role: { type: "string", enum: [...SUPPORTING_ROLES] },
            why: { type: "string", description: "One short sentence: why this line belongs in the clip." },
          },
          required: ["quote", "role", "why"],
        },
      },
    },
    required: ["supportingQuotes"],
  },
};

export interface StitchSectionInput {
  startSec: number;
  endSec: number;
  topic: string | null;
  summary: string | null;
  anchorQuote: string | null;
}

function mmss(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export function buildStitchUserMessage(args: {
  title: string | null;
  section: StitchSectionInput;
  transcriptMarkdown: string;
}): string {
  const s = args.section;
  const transcript =
    args.transcriptMarkdown.length > TRANSCRIPT_CHAR_BUDGET
      ? `${args.transcriptMarkdown.slice(0, TRANSCRIPT_CHAR_BUDGET)}\n[…transcript truncated]`
      : args.transcriptMarkdown;
  return [
    args.title ? `VIDEO: ${args.title}` : null,
    `SECTION (the clip): [${mmss(s.startSec)}]–[${mmss(s.endSec)}] (${s.startSec}s–${s.endSec}s)`,
    s.topic ? `Topic: ${s.topic}` : null,
    s.summary ? `Summary: ${s.summary}` : null,
    s.anchorQuote ? `Its key line: "${s.anchorQuote}"` : null,
    ``,
    `FULL TRANSCRIPT:`,
    transcript,
    ``,
    `TASK: name 0-${MAX_SUPPORTING_MOMENTS} lines from OUTSIDE [${mmss(s.startSec)}]–[${mmss(s.endSec)}] an editor would stitch into this clip.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export type StitchSuggestResult =
  | { ok: true; quotes: unknown }
  | { ok: false; failure: { reason: "llm-error"; message: string } | { reason: "no-tool-call" } };

export async function suggestSupportingQuotes(args: {
  title: string | null;
  section: StitchSectionInput;
  transcriptMarkdown: string;
  client?: Anthropic;
}): Promise<StitchSuggestResult> {
  const client = args.client ?? new Anthropic();
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: buildStitchUserMessage(args) }],
    });
  } catch (err) {
    return { ok: false, failure: { reason: "llm-error", message: err instanceof Error ? err.message : String(err) } };
  }
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === TOOL.name) {
      return { ok: true, quotes: (block.input as { supportingQuotes?: unknown }).supportingQuotes ?? [] };
    }
  }
  return { ok: false, failure: { reason: "no-tool-call" } };
}
