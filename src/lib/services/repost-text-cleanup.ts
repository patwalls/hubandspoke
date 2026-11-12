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
//
// Speed (2026-11-12): the model used to echo the WHOLE body back through the
// tool, so the call cost ~1 output token per caption token (~2 s on a long
// caption — the p50 of POST /cross-post). It now names only the opener line
// (a few tokens) and the code removes that line structurally; a model that
// "returns" a line the body doesn't start with changes nothing. Answers are
// also remembered per body (in-process LRU), because a source is cross-posted
// to ~3 accounts in a row and the caption is the same each time.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";

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

…AND that opener is followed by a line break before the real content begins, return that opener line EXACTLY as it appears (character for character) as \`opener\`.

If the body does NOT have a standalone opener line of this shape — for example because the date phrase is part of a flowing sentence ("8 years ago today I learned the most important lesson of my career") — return an empty string as \`opener\`. The test is structural: an opener is a separate first line followed by a line break, not part of a sentence.

Never return any other text. Always call return_opener exactly once.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "return_opener",
    description:
      "Return the body's first line if it is a date-anchored opener, else an empty string.",
    input_schema: {
      type: "object" as const,
      properties: {
        opener: {
          type: "string",
          description:
            "The opener line exactly as written, or \"\" when there is none.",
        },
      },
      required: ["opener"],
    },
  },
];

export interface StripDateOpenerOptions {
  /** Override for tests. Defaults to a fresh `new Anthropic()`. */
  client?: Anthropic;
}

/**
 * Remove `opener` from the top of `body` when — and only when — the body's
 * first non-blank line IS that opener (whitespace-trimmed) and real content
 * follows it. Drops the blank line(s) after it too. Pure string surgery on a
 * line the model already picked out; anything that doesn't line up returns
 * the body unchanged.
 */
export function removeOpenerLine(body: string, opener: string): string {
  const want = opener.trim();
  if (want.length === 0) return body;
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== want) return body;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  // An opener must be followed by real content — never empty the body.
  if (j >= lines.length) return body;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return lines.slice(j).join(eol);
}

// Answers per body, newest last. Small: a body is only re-asked while its
// source is being cross-posted, minutes apart.
const MEMO_MAX = 200;
const memo = new Map<string, string>();

function remember(body: string, opener: string) {
  memo.delete(body);
  memo.set(body, opener);
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
}

/** Test hook: forget remembered answers. */
export function clearDateOpenerMemo() {
  memo.clear();
}

/**
 * Returns the body with a leading date-anchored opener line removed (if
 * present). Fail-soft: any LLM error, empty response, or pre-check skip
 * returns the original input unchanged. Failures are not remembered.
 *
 * Cost: ~$0.0002 per call (Haiku 5.5, ~400-token system prompt + the body
 * in, a few tokens out). Fires once per distinct body.
 */
export async function stripDateOpenerWithLLM(
  body: string | null | undefined,
  opts: StripDateOpenerOptions = {},
): Promise<string | null> {
  if (body == null) return null;
  const trimmed = body.trim();
  if (trimmed.length === 0) return body;
  if (trimmed.length < MIN_BODY_CHARS_FOR_LLM) return body;

  const known = memo.get(body);
  if (known !== undefined) {
    remember(body, known);
    return removeOpenerLine(body, known);
  }

  const client = opts.client ?? new Anthropic();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      // The answer is one line at most.
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "tool", name: "return_opener" },
      messages: [{ role: "user", content: body }],
    });
  } catch (err) {
    console.error(
      "stripDateOpenerWithLLM: LLM call failed; passing body through",
      err,
    );
    return body;
  }

  for (const block of response.content) {
    if (block.type !== "tool_use" || block.name !== "return_opener") continue;
    const input = block.input as { opener?: unknown };
    if (typeof input.opener !== "string") continue;
    remember(body, input.opener);
    return removeOpenerLine(body, input.opener);
  }

  // No tool_use block found — fail-soft.
  return body;
}
