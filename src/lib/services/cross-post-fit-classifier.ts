import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";

// Captions/tweets over ~1.5k chars are rare; clipping keeps tokens bounded
// without losing judgement signal. Matches evergreen-agent.ts.
const MAX_BODY_CHARS = 1500;

export interface CrossPostFitVerdict {
  isGoodFit: boolean;
  reasoning: string;
  /** True when the model/API failed and we fell back without recording a cached verdict. */
  isFallback: boolean;
}

const tools: Anthropic.Tool[] = [
  {
    name: "mark_good_fit",
    description:
      "Mark this post as a good candidate to cross-post to another platform. Use when the content is self-contained, durable, and would read naturally lifted off the source platform and placed somewhere else.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: {
          type: "string",
          description:
            "One or two sentences explaining why this content travels well — what makes it durable and self-contained.",
        },
      },
      required: ["reasoning"],
    },
  },
  {
    name: "mark_bad_fit",
    description:
      "Mark this post as a poor cross-post candidate. Use when the content is tied to a moment in time, leans on platform-native framing, is a short reaction with no reusable substance, or would feel off lifted to another platform.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: {
          type: "string",
          description:
            "One or two sentences explaining why this content should not be cross-posted. Cite the specific quality (time-sensitive, platform-native, thin reaction, etc.).",
        },
      },
      required: ["reasoning"],
    },
  },
];

const SYSTEM_PROMPT = `You are judging whether a social post is a good candidate to cross-post as-is (or with light tweaks) to a different platform days or weeks after the original ran.

A good cross-post is content that stands on its own: a lesson, a story, a framework, an observation, a teaching — the kind of thing a viewer encountering it cold on a different platform would still find valuable.

Signals the post is a GOOD fit to cross-post:
  - Self-contained idea, story, or lesson that doesn't need context from the original platform
  - Evergreen framing — the point still lands months later
  - The substance is in the text/caption itself, not in a reaction or link-out

Signals the post is a BAD fit to cross-post:
  - Tied to a specific moment: a news event, breaking story, product launch, earnings print, holiday, meme cycle, or current drama. Anything that would make a reader think "wait, this is old news" when they see it later.
  - Platform-native framing: threads that only make sense as threads, replies/quote-tweets, posts that reference the source platform itself ("here on X…", "as I tweeted"), or formats that don't translate (e.g., an X Space announcement).
  - Thin reactions: short "RIP", "lol", "this is wild", pure commentary on someone else's content with no substance of its own.
  - Link-only posts where the real payload lives elsewhere and the caption doesn't carry the idea.
  - References to specific current pricing, current stats, "this week", "today I", "yesterday".

The body text is the source of truth. Titles are often truncated or platform-generated and can mislead — judge primarily on the body.

You must call exactly one tool — never respond with plain text. When genuinely uncertain, lean toward \`mark_bad_fit\`: a false negative just means one fewer cross-post suggestion; a false positive means stale or awkward content on the queue.`;

export async function classifyCrossPostFit(params: {
  title: string | null;
  contentBody: string | null;
  sourcePlatform: string;
  publishedDate: string | null;
  format?: string | null;
  brand?: string | null;
}): Promise<CrossPostFitVerdict> {
  const body = params.contentBody?.trim() ?? "";
  if (!body) {
    return {
      isGoodFit: true,
      reasoning: "No content body captured; defaulting to fit.",
      isFallback: true,
    };
  }

  const client = new Anthropic();

  const bodySection = `Body:\n"""\n${body.slice(0, MAX_BODY_CHARS)}${
    body.length > MAX_BODY_CHARS ? "…" : ""
  }\n"""`;

  const userMessage = [
    `Source platform: ${params.sourcePlatform}`,
    `Title: "${params.title ?? "(none)"}"`,
    `Format: ${params.format ?? "(none)"}`,
    `Brand: ${params.brand ?? "(none)"}`,
    `Originally published: ${params.publishedDate ?? "(unknown)"}`,
    ``,
    bodySection,
    ``,
    `Judge this as a cross-post candidate. Call exactly one tool.`,
  ].join("\n");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: userMessage }],
    });

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as { reasoning?: string };
      if (typeof input.reasoning !== "string" || !input.reasoning.trim()) continue;

      if (block.name === "mark_good_fit") {
        return {
          isGoodFit: true,
          reasoning: input.reasoning.trim(),
          isFallback: false,
        };
      }
      if (block.name === "mark_bad_fit") {
        return {
          isGoodFit: false,
          reasoning: input.reasoning.trim(),
          isFallback: false,
        };
      }
    }

    return {
      isGoodFit: true,
      reasoning:
        "Classifier returned no valid tool call; treating as fit and skipping cache.",
      isFallback: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isGoodFit: true,
      reasoning: `Classifier error (${message}); treating as fit and skipping cache.`,
      isFallback: true,
    };
  }
}
