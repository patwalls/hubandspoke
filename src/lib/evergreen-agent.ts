import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

export interface EvergreenVerdict {
  isEvergreen: boolean;
  reasoning: string;
}

const tools: Anthropic.Tool[] = [
  {
    name: "mark_evergreen",
    description:
      "Mark the content as evergreen. Use when the piece would still be valid and interesting to a new viewer 12+ months from now, is not tied to a specific moment, event, news cycle, or launch, and does not lean on time-sensitive stats or promises.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: {
          type: "string",
          description:
            "One or two sentences explaining WHY this piece is still evergreen. Cite the topic or framing that gives it long shelf life.",
        },
      },
      required: ["reasoning"],
    },
  },
  {
    name: "mark_not_evergreen",
    description:
      "Mark the content as NOT evergreen. Use when the piece is tied to a specific moment (a launch, a news event, a holiday, a sale, a cohort, a current product price), contains stats/claims that would feel stale in a year, or is obviously seasonal.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: {
          type: "string",
          description:
            "One or two sentences explaining WHY this piece is not evergreen. Cite the time-sensitive element.",
        },
      },
      required: ["reasoning"],
    },
  },
];

const SYSTEM_PROMPT = `You are an evergreen-content classifier for a content production dashboard. A piece of content is "evergreen" when a viewer encountering it for the first time 12+ months from now would still find it valid, interesting, and non-dated.

Evergreen signals:
  - Foundational lessons, frameworks, mental models, life advice
  - Stories about a specific founder/person/business that are timeless (e.g. "how I built this", a narrative)
  - "How to" guides that aren't tied to a specific tool version or trend
  - Broad observations about human nature, work, money, creativity

NOT evergreen signals:
  - Tied to a specific event, launch, release, news cycle, holiday, season, or current pricing
  - Stats with specific recent dates ("this week", "in Q4 2025", "last month")
  - References to trends, memes, or viral moments that will age badly
  - Product reviews of fast-moving products (AI tools, crypto, new apps)
  - Seasonal or calendar-pinned content (Black Friday, tax season, New Year)
  - "Yesterday I…", "today I…", anything overtly framed as current news

You must call exactly one tool — never respond with plain text. Default to \`mark_not_evergreen\` when genuinely uncertain: a false negative just means we skip a repost; a false positive means we push stale content onto the queue.`;

export async function classifyEvergreen(params: {
  title: string;
  platform: string[] | null;
  publishedDate: string | null;
  format?: string | null;
}): Promise<EvergreenVerdict> {
  const client = new Anthropic();

  const userMessage = [
    `Title: "${params.title}"`,
    `Format: ${params.format ?? "(none)"}`,
    `Channels: ${params.platform?.join(", ") || "(none)"}`,
    `Originally published: ${params.publishedDate ?? "(unknown)"}`,
    ``,
    `Classify this as evergreen or not. Call exactly one tool.`,
  ].join("\n");

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

    if (block.name === "mark_evergreen") {
      return { isEvergreen: true, reasoning: input.reasoning.trim() };
    }
    if (block.name === "mark_not_evergreen") {
      return { isEvergreen: false, reasoning: input.reasoning.trim() };
    }
  }

  // Defensive fallback mirrors repurpose-agent.ts: if the model returned
  // malformed args, treat as not-evergreen so we don't surface questionable
  // content. Record the reason so the next operator knows it was a fallback.
  return {
    isEvergreen: false,
    reasoning:
      "Classifier returned no valid tool call; defaulting to not-evergreen.",
  };
}
