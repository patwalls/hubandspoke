/**
 * Filler-word detection for the clip editor.
 *
 * An LLM, not a word list: whether "like", "so", "right" or "you know" is
 * filler depends on the sentence ("I like it" vs "it was, like, huge"), which
 * is exactly the free-form-content judgment CLAUDE.md says not to regex.
 * Shape mirrors services/draft-algorithm/derivative-hook.ts — Haiku, one
 * pinned tool, fail-soft `{ ok: false, failure }`.
 *
 * The model only ever returns word POSITIONS from the numbered list we send,
 * so it cannot invent or rewrite transcript text; anything out of range is
 * dropped. What to do with the positions (cut ranges) stays deterministic.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EditorWord } from "@/lib/clip-editor/words";

const MODEL = "claude-haiku-4-5-20251001";

/** ~6 minutes of speech. A clip is ≤ ~2 min; the cap just bounds the prompt
 *  if someone drags the trim handles across a huge range. */
const MAX_WORDS = 1200;

const SYSTEM_PROMPT = `You clean up spoken-word transcripts for short-form video editing.

You receive the words of a clip as a numbered list, one "<number>: <word>" per line, in spoken order. Identify the words that are FILLER — words a video editor would cut to tighten the speech without changing its meaning:
- hesitation sounds: um, uh, er, ah, hmm
- discourse filler used as padding: "like", "you know", "I mean", "sort of", "kind of", "basically", "literally", "right?", "so" at the start of a thought — ONLY when they carry no meaning in that sentence
- false starts and stutters: a word or short phrase immediately repeated or abandoned ("I I think", "we went — we decided")

Do NOT mark a word that carries meaning: "like" as a verb or comparison, "so" meaning "therefore", "right" meaning "correct", "kind of" when it genuinely softens a claim the speaker intends to soften. When unsure, leave the word in — a wrongly cut word is worse than a filler left in. For a repeated word or phrase, mark the FIRST occurrence and keep the last.

Never respond with plain text. Always call report_fillers exactly once. If there is no filler, call it with an empty list.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "report_fillers",
    description:
      "Report which numbered words are filler that should be cut from the clip.",
    input_schema: {
      type: "object" as const,
      properties: {
        fillerWordNumbers: {
          type: "array",
          items: { type: "integer" },
          description:
            "The numbers (from the provided list) of every filler word. Empty if none.",
        },
      },
      required: ["fillerWordNumbers"],
    },
  },
];

export type DetectFillersFailure =
  | { reason: "no-words" }
  | { reason: "llm-no-tool-call" }
  | { reason: "llm-error"; message: string; retryable: boolean };

export type DetectFillersResult =
  | { ok: true; fillerIndexes: number[] }
  | { ok: false; failure: DetectFillersFailure };

/**
 * @param words the words of the clip, in spoken order
 * @returns `EditorWord.index` values of the filler words
 */
export async function detectFillerWords(args: {
  words: EditorWord[];
  /** Override for tests. Defaults to a fresh `new Anthropic()`. */
  client?: Anthropic;
}): Promise<DetectFillersResult> {
  const words = args.words.slice(0, MAX_WORDS);
  if (words.length === 0) return { ok: false, failure: { reason: "no-words" } };

  // Number by POSITION (1…n), not by transcript index: small sequential
  // numbers are easier for the model to echo back reliably than sparse
  // five-digit ones.
  const listing = words.map((w, i) => `${i + 1}: ${w.text}`).join("\n");
  const client = args.client ?? new Anthropic();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      // As repeatable as the API allows: the same clip should get the same
      // suggestions. (The result only becomes an edit once it's applied to
      // the doc — from there on, everything IS deterministic.)
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "report_fillers" },
      messages: [
        {
          role: "user",
          content: `## CLIP WORDS\n${listing}\n\nCall report_fillers now.`,
        },
      ],
    });
  } catch (err) {
    const retryable =
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.APIConnectionError ||
      (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500);
    return {
      ok: false,
      failure: {
        reason: "llm-error",
        message: err instanceof Error ? err.message : String(err),
        retryable,
      },
    };
  }

  for (const block of response.content) {
    if (block.type !== "tool_use" || block.name !== "report_fillers") continue;
    const raw = (block.input as { fillerWordNumbers?: unknown }).fillerWordNumbers;
    const positions = Array.isArray(raw) ? raw : [];
    const seen = new Set<number>();
    for (const p of positions) {
      if (!Number.isInteger(p) || p < 1 || p > words.length) continue;
      seen.add(words[(p as number) - 1].index);
    }
    return { ok: true, fillerIndexes: [...seen].sort((a, b) => a - b) };
  }
  return { ok: false, failure: { reason: "llm-no-tool-call" } };
}
