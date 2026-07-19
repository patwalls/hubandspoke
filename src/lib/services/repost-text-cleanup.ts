// Strip the date-anchored opener line from a source post body before it
// gets seeded into a repost / cross-post draft.
//
// Why an LLM and not a regex: post bodies are free-form social-media copy.
// Operators write openers in dozens of shapes ("8 years ago today:", "Last
// year I was…", "Today, a decade ago:", "5 years ago this week —") and they
// also sometimes genuinely START the body with a temporal phrase ("8 years
// ago today I learned the most important lesson…"). A regex either misses
// half the openers or eats real body text. A small model handles the
// distinction trivially.
//
// Fail-soft: any error or empty output returns the original body unchanged.
// This is optional polish — a failed cleanup should not block the repost.

import type OpenAI from "openai";
import { openai } from "@/lib/openai";

const MODEL = "gpt-4.1-mini";

// Skip the LLM entirely when there can't possibly be an opener-plus-body
// shape. Cheapest possible no-op and saves a round trip.
const MIN_BODY_CHARS_FOR_LLM = 30;

const SYSTEM_PROMPT = `You receive the body of a social-media post. If the body STARTS WITH a date-anchored opener line that announces the post is about a past moment — examples:

- "8 years ago today:"
- "9 years ago:"
- "Today, 5 years ago:"
- "Last year:"
- "Yesterday:"
- "5 years ago this week:"
- "A year ago today —"

…AND that opener is followed by a line break before the real content begins, then REMOVE the opener line and the blank line(s) that follow it, returning the body that starts with its real content.

If the body does NOT have a standalone opener line of this shape — for example because the date phrase is part of a flowing sentence ("8 years ago today I learned the most important lesson of my career") — return the body UNCHANGED. The test is structural: an opener is a separate line followed by a line break, not part of a sentence.

Preserve everything else exactly as-is: no rewriting, no reflowing, no emoji or punctuation changes. The only allowed transform is removing a leading opener line (and the blank line after it).

Always call return_body exactly once.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "return_body",
      description:
        "Return the cleaned body. If no opener was present, return the input unchanged.",
      parameters: {
        type: "object" as const,
        properties: {
          body: {
            type: "string",
            description:
              "The cleaned body. Same as input if no opener was found.",
          },
        },
        required: ["body"],
      },
    },
  },
];

export interface StripDateOpenerOptions {
  /** Override for tests. Defaults to the shared `openai()` client. */
  client?: OpenAI;
}

/**
 * Returns the body with a leading date-anchored opener line removed (if
 * present). Fail-soft: any LLM error, empty response, or pre-check skip
 * returns the original input unchanged.
 *
 * Cost: cheap per call (gpt-4.1-mini, ~500-token system prompt + a
 * typical post body). Fires once per repost / cross-post creation.
 */
export async function stripDateOpenerWithLLM(
  body: string | null | undefined,
  opts: StripDateOpenerOptions = {},
): Promise<string | null> {
  if (body == null) return null;
  const trimmed = body.trim();
  if (trimmed.length === 0) return body;
  if (trimmed.length < MIN_BODY_CHARS_FOR_LLM) return body;

  const client = opts.client ?? openai();

  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      // Generous ceiling — we never expect more output than input, but a
      // tight cap can truncate the tool call on long bodies.
      max_tokens: Math.max(1024, Math.ceil(body.length / 2) + 512),
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "return_body" } },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: body },
      ],
    });
  } catch (err) {
    console.error(
      "stripDateOpenerWithLLM: LLM call failed; passing body through",
      err,
    );
    return body;
  }

  for (const call of response.choices[0]?.message?.tool_calls ?? []) {
    if (call.type !== "function" || call.function.name !== "return_body")
      continue;
    let input: { body?: unknown };
    try {
      input = JSON.parse(call.function.arguments) as { body?: unknown };
    } catch {
      // Malformed tool arguments — treat as fail-soft.
      return body;
    }
    if (typeof input.body !== "string") continue;
    if (input.body.trim().length === 0) {
      // Model returned nothing usable — treat as fail-soft.
      return body;
    }
    return input.body;
  }

  // No tool call found — fail-soft.
  return body;
}
