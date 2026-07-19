// Per-derivative hook generation for the Draft Algorithm V1.7 Descript
// branch. Fires when a format's `### Descript Clip & Pack Info` Skill
// uses the `{{hook}}` placeholder — without this step, the literal text
// "{{ hook }}" gets stamped onto the clip (see the Angus Cheng incident
// in `Repackage Tech Stack With Hook`).
//
// Why a separate generator vs. reusing `hook-extract/orchestrator.ts`:
// orchestrator extracts the verbatim opening line of an *existing*
// short-form transcript — it runs after publish. Derivative hook
// generation runs *before* Descript cuts the clip, so there is no
// derivative transcript yet. We work from the pillar transcript plus the
// Skill's clip instructions to predict the segment Underlord will pick.
//
// Style anchor: past hooks from the same format, ordered by views. The
// six in-use formats today each have 10–80 prior hooks with a strong
// stylistic pattern (length, emoji density, MRR-numbers cadence) the
// model has to mirror.

import type OpenAI from "openai";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { openai } from "@/lib/openai";
import { productionItems, transcripts } from "@/lib/db/schema";

const MODEL = "gpt-4.1-mini";
export const HOOK_EXTRACTOR_VERSION = `${MODEL}:derivative-hook:v1`;

const MAX_EXEMPLARS = 12;
// Pillar transcripts can be 20k+ words. Cap input to keep latency low and
// avoid pushing past Haiku's effective context for one-shot calls. The
// Skill clip instructions describe which segment to find, so the model
// usually only needs a few thousand words to localize.
const TRANSCRIPT_CHAR_BUDGET = 24_000;

export interface GenerateDerivativeHookArgs {
  /** The format the derivative belongs to — used to pick exemplar hooks
   *  from prior items in the same format. */
  formatName: string;
  /** Excluded from the exemplar pool so a Redraft doesn't train on its
   *  own prior (often stale) hook. */
  derivativeItemId: string;
  /** Source video — its transcript is the substrate the LLM reads to
   *  pick a hook from. */
  pillarItemId: string;
  /** Just the `### Descript Clip & Pack Info` section. Tells the LLM
   *  which part of the pillar Underlord is about to clip out, so the
   *  generated hook actually relates to that segment. */
  skillSection: string;
  /** Override for tests. Defaults to the shared `openai()` client. */
  client?: OpenAI;
}

export interface GeneratedHook {
  hook: string;
  source: "derivative-hook-v1";
  extractor: string;
  exemplarCount: number;
}

export type DerivativeHookFailure =
  | { reason: "no-pillar-transcript" }
  | { reason: "llm-empty" }
  | { reason: "llm-error"; message: string };

export type GenerateDerivativeHookResult =
  | { ok: true; value: GeneratedHook }
  | { ok: false; failure: DerivativeHookFailure };

const SYSTEM_PROMPT = `You write the on-screen HOOK text for a short-form vertical video clip.

The hook is a single attention-grabbing line that will be burned in at the top of the clip — it's what makes someone stop scrolling and watch. You write it BEFORE the clip is cut, so you have to predict the substance of the segment that will be clipped, based on the format's clip instructions and the pillar transcript.

RULES
- Match the style of the past hooks EXACTLY — same voice, length, punctuation, emoji usage. If past hooks are one short sentence with one emoji, yours is too. If past hooks are dry and numeric, yours is too.
- Ground the hook in something specific from the segment the clip instructions describe (a number, a tool name, an outcome). Generic hooks ("This founder's tech stack will blow your mind") underperform.
- Typical length: 6–18 words. One sentence. No leading hashtags. No CTA. No links.
- Never include the format name or the word "clip"/"video" — the hook is in-world copy, not a description of the post.

Never respond with plain text. Always call return_hook exactly once.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "return_hook",
      description:
        "Return the single on-screen hook line that matches the format's style and is grounded in the clipped segment.",
      parameters: {
        type: "object" as const,
        properties: {
          hook: {
            type: "string",
            description:
              "One short sentence, 6–18 words. Match the style of the past hooks exactly. No quotes around it — just the bare text.",
          },
        },
        required: ["hook"],
      },
    },
  },
];

async function loadExemplars(
  formatName: string,
  excludeItemId: string,
): Promise<string[]> {
  const rows = await db
    .select({ hook: productionItems.hook })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.format, formatName),
        isNotNull(productionItems.hook),
        sql`length(trim(${productionItems.hook})) > 0`,
        ne(productionItems.id, excludeItemId),
      ),
    )
    // Highest-performing first; null views sort last so we still get
    // exemplars for formats whose performance sync hasn't run.
    .orderBy(desc(productionItems.views), desc(productionItems.publishedDate))
    .limit(MAX_EXEMPLARS);
  return rows.map((r) => r.hook!).filter((h) => h.trim().length > 0);
}

async function loadPillarTranscript(
  pillarItemId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ fullText: transcripts.fullText })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, pillarItemId))
    .limit(1);
  if (!row?.fullText) return null;
  const text = row.fullText.trim();
  if (text.length === 0) return null;
  if (text.length <= TRANSCRIPT_CHAR_BUDGET) return text;
  // Keep the head — clip instructions usually target a specific topic
  // and the transcript is dense; the model doesn't need every word.
  return text.slice(0, TRANSCRIPT_CHAR_BUDGET);
}

function renderExemplarsBlock(exemplars: string[]): string {
  if (exemplars.length === 0) {
    return "(No past hooks for this format yet — keep it short, specific, and benefit-driven.)";
  }
  return exemplars.map((h, i) => `${i + 1}. ${h}`).join("\n");
}

/**
 * Generate a hook for a Descript derivative whose format Skill carries
 * the `{{hook}}` placeholder. Fail-soft: if the pillar has no transcript,
 * the caller should fire Descript with the placeholder intact (logged
 * warning) rather than block the clip.
 */
export async function generateDerivativeHook(
  args: GenerateDerivativeHookArgs,
): Promise<GenerateDerivativeHookResult> {
  const transcript = await loadPillarTranscript(args.pillarItemId);
  if (!transcript) {
    return { ok: false, failure: { reason: "no-pillar-transcript" } };
  }

  const exemplars = await loadExemplars(
    args.formatName,
    args.derivativeItemId,
  );

  const client = args.client ?? openai();

  const userText = [
    `## FORMAT: ${args.formatName}\n\n## PAST HOOKS IN THIS FORMAT (style reference — match these exactly)\n${renderExemplarsBlock(exemplars)}`,
    `## CLIP INSTRUCTIONS (the segment Underlord will cut out of the pillar — your hook should describe THIS segment, not the whole pillar)\n${args.skillSection.trim()}`,
    `## PILLAR TRANSCRIPT (read this to find the actual content of the clipped segment)\n${transcript}`,
    "Write the hook now. Call return_hook exactly once.",
  ].join("\n\n");

  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 256,
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "return_hook" } },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    });
  } catch (err) {
    return {
      ok: false,
      failure: {
        reason: "llm-error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  for (const call of response.choices[0]?.message?.tool_calls ?? []) {
    if (call.type !== "function" || call.function.name !== "return_hook") continue;
    let input: { hook?: unknown };
    try {
      input = JSON.parse(call.function.arguments) as { hook?: unknown };
    } catch {
      return { ok: false, failure: { reason: "llm-empty" } };
    }
    const hook = typeof input.hook === "string" ? input.hook.trim() : "";
    if (hook.length === 0) {
      return { ok: false, failure: { reason: "llm-empty" } };
    }
    return {
      ok: true,
      value: {
        hook,
        source: "derivative-hook-v1",
        extractor: HOOK_EXTRACTOR_VERSION,
        exemplarCount: exemplars.length,
      },
    };
  }

  return { ok: false, failure: { reason: "llm-empty" } };
}

/** Cheap pre-check before doing any DB / LLM work. Matches the same
 *  placeholder grammar as `substituteFormatPrompt` in `@/lib/descript`
 *  so `{{hook}}` and `{{ hook }}` both count. */
export function skillUsesHookPlaceholder(skill: string): boolean {
  return /\{\{\s*hook\s*\}\}/.test(skill);
}
