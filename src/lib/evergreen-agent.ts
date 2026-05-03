import { openai } from "@/lib/openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const MODEL = "gpt-4.1-mini";

// How much of the body to send to the classifier. Captions over ~1.5k chars
// are rare; clipping keeps tokens bounded without losing judgement signal.
const MAX_BODY_CHARS = 1500;

export interface EvergreenVerdict {
  isEvergreen: boolean;
  reasoning: string;
}

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "mark_evergreen",
      description:
        "Mark the content as evergreen. Use when the piece would still be valid and interesting to a new viewer 12+ months from now, is not tied to a specific moment, event, news cycle, or launch, and does not lean on time-sensitive stats or promises.",
      parameters: {
        type: "object",
        properties: {
          reasoning: {
            type: "string",
            description:
              "One or two sentences explaining WHY this piece is still evergreen. Cite the topic or framing that gives it long shelf life.",
          },
        },
        required: ["reasoning"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "mark_not_evergreen",
      description:
        "Mark the content as NOT evergreen. Use when the piece is tied to a specific moment (a launch, a news event, a holiday, a sale, a cohort, a current product price), contains stats/claims that would feel stale in a year, or is obviously seasonal.",
      parameters: {
        type: "object",
        properties: {
          reasoning: {
            type: "string",
            description:
              "One or two sentences explaining WHY this piece is not evergreen. Cite the time-sensitive element.",
          },
        },
        required: ["reasoning"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const BASE_SYSTEM_PROMPT = `You are an evergreen-content classifier for a content production dashboard. A piece of content is "evergreen" when a viewer encountering it for the first time 12+ months from now would still find it valid, interesting, and non-dated.

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

When a full Body is provided, judge primarily on the body text — the title is often truncated or platform-generated (especially for Instagram) and does not reflect the actual post. The body is the source of truth.

You must call exactly one tool — never respond with plain text. Default to \`mark_not_evergreen\` when genuinely uncertain: a false negative just means we skip a repost; a false positive means we push stale content onto the queue.`;

export interface PastKillReason {
  reason: string;
  postType?: string | null;
}

function buildSystemPrompt(pastKills: PastKillReason[] | undefined): string {
  if (!pastKills || pastKills.length === 0) return BASE_SYSTEM_PROMPT;
  const lines = pastKills
    .filter((k) => typeof k.reason === "string" && k.reason.trim().length > 0)
    .slice(0, 10)
    .map((k) => {
      const tag = k.postType ? ` [${k.postType}]` : "";
      return `  - ${k.reason.trim()}${tag}`;
    });
  if (lines.length === 0) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

Recent operator rejections of repost ideas. Use these as signal for the kind of content the operator no longer wants resurfaced — if the current item is likely to draw a similar rejection, lean toward \`mark_not_evergreen\`:
${lines.join("\n")}`;
}

export async function classifyEvergreen(params: {
  title: string;
  postType: string | null;
  publishedDate: string | null;
  format?: string | null;
  contentBody?: string | null;
  hasArchivedMedia?: boolean;
  pastKillReasons?: PastKillReason[];
}): Promise<EvergreenVerdict> {
  const bodyTrimmed = params.contentBody?.trim() ?? "";
  const bodySection = bodyTrimmed
    ? `Body:\n"""\n${bodyTrimmed.slice(0, MAX_BODY_CHARS)}${
        bodyTrimmed.length > MAX_BODY_CHARS ? "…" : ""
      }\n"""`
    : `Body: (none captured)`;

  const userMessage = [
    `Title: "${params.title}"`,
    `Format: ${params.format ?? "(none)"}`,
    `Post type: ${params.postType ?? "(none)"}`,
    `Originally published: ${params.publishedDate ?? "(unknown)"}`,
    `Archived media available: ${params.hasArchivedMedia ? "yes" : "no"}`,
    ``,
    bodySection,
    ``,
    `Classify this as evergreen or not. Call exactly one tool.`,
  ].join("\n");

  const response = await openai().chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    tools,
    tool_choice: "required",
    messages: [
      { role: "system", content: buildSystemPrompt(params.pastKillReasons) },
      { role: "user", content: userMessage },
    ],
  });

  const message = response.choices[0]?.message;
  for (const call of message?.tool_calls ?? []) {
    if (call.type !== "function") continue;
    let input: { reasoning?: string };
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      continue;
    }
    if (typeof input.reasoning !== "string" || !input.reasoning.trim()) continue;

    if (call.function.name === "mark_evergreen") {
      return { isEvergreen: true, reasoning: input.reasoning.trim() };
    }
    if (call.function.name === "mark_not_evergreen") {
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

export interface RepostAcceptExemplar {
  title: string;
  postType: string | null;
  format: string | null;
}

export interface RepostFitVerdict {
  wouldRepost: boolean;
  reasoning: string;
}

const fitTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "mark_would_repost",
      description:
        "Mark this candidate as a good repost fit. Use when the candidate resembles content the operator has actually published as a repost before, and does NOT resemble the kinds of content they've killed.",
      parameters: {
        type: "object",
        properties: {
          reasoning: {
            type: "string",
            description:
              "One or two sentences citing which accept exemplars this is similar to, or why no kill reason applies.",
          },
        },
        required: ["reasoning"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "mark_would_skip",
      description:
        "Mark this candidate as a bad repost fit. Use when the candidate resembles a recent kill reason (same topic, same framing, same operator objection), or when it doesn't resemble anything the operator has actually published as a repost.",
      parameters: {
        type: "object",
        properties: {
          reasoning: {
            type: "string",
            description:
              "One or two sentences citing the matching kill reason or the lack of similar accept exemplars.",
          },
        },
        required: ["reasoning"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const FIT_SYSTEM_PROMPT = `You are a repost-fit judge for a content production dashboard. An evergreen classifier already decided this candidate is "still valid in 12+ months." Your job is narrower: would the human operator actually want it suggested, given how they've behaved on similar items?

You have two signals:
  - KILL_REASONS: items the operator killed when offered as a repost, with their reason. These are the exact kinds of content they don't want resurfaced.
  - ACCEPT_EXEMPLARS: items they accepted and actually published as a repost. These are the kinds of content they do want resurfaced.

Decision rule:
  - If the candidate's topic, framing, or objection-pattern resembles a kill reason → \`mark_would_skip\`.
  - If it resembles an accept exemplar and does not match a kill → \`mark_would_repost\`.
  - If neither side has signal yet (cold start with empty lists, or unrelated to anything seen) → \`mark_would_repost\` (don't block on lack of evidence).
  - When genuinely torn between a partial kill match and a partial accept match → \`mark_would_skip\`. A false skip costs one missed repost; a false accept puts content the operator is sick of seeing back in their queue, which is the failure mode we are fixing.

Match on substance, not surface keywords. "What I made last year" and "my salary" are the same topic. "Mental models on building" and "mental models on hiring" are not — both can be evergreen but the kill reason has to actually apply.

You must call exactly one tool — never respond with plain text.`;

function formatAcceptExemplars(items: RepostAcceptExemplar[]): string {
  if (items.length === 0) return "(none yet)";
  return items
    .slice(0, 20)
    .map((it) => {
      const tag = it.postType ? ` [${it.postType}]` : "";
      const fmt = it.format ? ` (${it.format})` : "";
      return `  - "${it.title}"${tag}${fmt}`;
    })
    .join("\n");
}

function formatKillReasons(items: PastKillReason[]): string {
  if (items.length === 0) return "(none yet)";
  return items
    .slice(0, 30)
    .filter((k) => typeof k.reason === "string" && k.reason.trim().length > 0)
    .map((k) => {
      const tag = k.postType ? ` [${k.postType}]` : "";
      return `  - ${k.reason.trim()}${tag}`;
    })
    .join("\n");
}

export async function judgeRepostFit(params: {
  title: string;
  postType: string | null;
  publishedDate: string | null;
  format?: string | null;
  contentBody?: string | null;
  pastKillReasons: PastKillReason[];
  pastAcceptExemplars: RepostAcceptExemplar[];
}): Promise<RepostFitVerdict> {
  const bodyTrimmed = params.contentBody?.trim() ?? "";
  const bodySection = bodyTrimmed
    ? `Body:\n"""\n${bodyTrimmed.slice(0, MAX_BODY_CHARS)}${
        bodyTrimmed.length > MAX_BODY_CHARS ? "…" : ""
      }\n"""`
    : `Body: (none captured)`;

  const userMessage = [
    `CANDIDATE`,
    `Title: "${params.title}"`,
    `Format: ${params.format ?? "(none)"}`,
    `Post type: ${params.postType ?? "(none)"}`,
    `Originally published: ${params.publishedDate ?? "(unknown)"}`,
    ``,
    bodySection,
    ``,
    `KILL_REASONS (recent operator rejections):`,
    formatKillReasons(params.pastKillReasons),
    ``,
    `ACCEPT_EXEMPLARS (originals the operator has already republished and published):`,
    formatAcceptExemplars(params.pastAcceptExemplars),
    ``,
    `Decide. Call exactly one tool.`,
  ].join("\n");

  const response = await openai().chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    tools: fitTools,
    tool_choice: "required",
    messages: [
      { role: "system", content: FIT_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  const message = response.choices[0]?.message;
  for (const call of message?.tool_calls ?? []) {
    if (call.type !== "function") continue;
    let input: { reasoning?: string };
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      continue;
    }
    if (typeof input.reasoning !== "string" || !input.reasoning.trim()) continue;

    if (call.function.name === "mark_would_repost") {
      return { wouldRepost: true, reasoning: input.reasoning.trim() };
    }
    if (call.function.name === "mark_would_skip") {
      return { wouldRepost: false, reasoning: input.reasoning.trim() };
    }
  }

  // Defensive fallback. A malformed model response shouldn't gate a suggestion
  // — fall back to letting the existing pipeline handle it (i.e. would-repost).
  // The upstream evergreen classification already provided basic safety.
  return {
    wouldRepost: true,
    reasoning: "Fit judge returned no valid tool call; defaulting to would-repost.",
  };
}
