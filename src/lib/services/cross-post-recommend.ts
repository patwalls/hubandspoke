import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";

// Captions/tweets over ~1.5k chars are rare; clipping keeps tokens bounded
// without losing judgement signal.
const MAX_BODY_CHARS = 1500;

export interface CandidateTarget {
  targetAccountId: string;
  handle: string;
  platform: string;
  postType: string;
  /** Optional: a sample of recent winners on this account for voice calibration. */
  voiceSample?: string;
}

export interface PastOutcome {
  outcome: "accepted" | "killed";
  reason: string;
  /** Tag describing the source → target pair that was actioned. */
  pair?: string | null;
}

export interface Proposal {
  targetAccountId: string;
  targetPostType: string;
  confidence: number;
  reasoning: string;
}

export interface RecommendResult {
  proposals: Proposal[];
  /** True when the model/API failed and we fell back without recording decisions. */
  isFallback: boolean;
  fallbackReason?: string;
}

const tools: Anthropic.Tool[] = [
  {
    name: "submit_proposals",
    description:
      "Return the set of target accounts (possibly empty) where this source post should be cross-posted. Each proposal carries a 0-100 confidence and a short reason. Return an empty array when no candidate target is a strong fit.",
    input_schema: {
      type: "object" as const,
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target_account_id: {
                type: "string",
                description:
                  "The target_account_id exactly as given in the candidate list. Must be one of the supplied options.",
              },
              target_post_type: {
                type: "string",
                description:
                  "The target post_type exactly as given in the candidate list for the chosen account.",
              },
              confidence: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description:
                  "0-100. Use 70+ only when you would personally publish this. Reserve 90+ for near-certain wins. Use <70 when the fit is marginal — those proposals will be logged but filtered out of the operator's queue.",
              },
              reasoning: {
                type: "string",
                description:
                  "One or two sentences. Explain why THIS specific post fits THIS specific target account + post type, and how the velocity / substance / tone played into the decision.",
              },
            },
            required: ["target_account_id", "target_post_type", "confidence", "reasoning"],
            additionalProperties: false,
          },
        },
      },
      required: ["proposals"],
      additionalProperties: false,
    },
  },
];

const BASE_SYSTEM_PROMPT = `You are the routing brain for an operator-facing cross-posting tool. A cross-post is re-publishing an already-winning post to another account verbatim (or near-verbatim) — NOT a re-authored repurpose. Someone else does the re-authoring; your job is purely to spot when the same text/video/image would work as-is on another platform.

You will be given:
- The source post (title, body, media signal, platform, post type).
- The source's velocity — current views and how that compares to this account's baseline at the same age. High velocity is the whole reason we're considering this post; treat it as "this content is resonating right now."
- A pre-filtered list of candidate targets (account + post type). All candidates are format-compatible with the source (we already gated that in code). You are judging content fit, not format compatibility.
- Recent operator feedback — which past cross-posts were accepted and killed, with reasons. Treat these as policy: pattern-match against them.

For each candidate target, decide whether the source would work there AS-IS. Core checks:

1. **Substance / durability.** Is the content self-contained, evergreen, and valuable to a viewer encountering it cold on the target? Bad signals: tied to a specific moment or launch, platform-native framing ("as I tweeted"), thin reactions ("lol", "RIP"), replies to something else, link-only posts where the payload lives elsewhere.

2. **Voice & audience match.** Does the tone and topic match what the target account's audience expects? A first-person founder note from Pat resonates on his LinkedIn but can feel off on the brand X account. If a voice sample is provided for the target account, use it.

3. **Feedback loop.** If the operator recently killed a similar (source→target) pair with a reason, lean hard toward not proposing — or lower confidence.

Confidence guidance:
- **90+** — would bet money this gets published. Rare.
- **70-89** — would personally recommend it. This is the bar for inclusion in the operator's queue.
- **50-69** — marginal; interesting but not strong. Log these so the operator can see what you considered, but they will not appear in the queue.
- **<50** — worth logging only if asked. Usually better to omit from the proposals entirely than include at low confidence.

You must call exactly one tool — \`submit_proposals\` — with the full list. Return an empty array when no candidate target is a strong fit; do not pad the response.`;

function formatMedia(params: {
  hasVideo?: boolean;
  hasImage?: boolean;
  mediaCount?: number;
}): string {
  const parts: string[] = [];
  if (params.hasVideo) parts.push("video");
  if (params.hasImage) parts.push("image");
  if (parts.length === 0) return "(none — text only)";
  const count = params.mediaCount ?? 0;
  return count > 1 ? `${parts.join(" + ")} (${count} items)` : parts.join(" + ");
}

function buildSystemPrompt(pastOutcomes: PastOutcome[] | undefined): string {
  if (!pastOutcomes || pastOutcomes.length === 0) return BASE_SYSTEM_PROMPT;
  const kills = pastOutcomes.filter((o) => o.outcome === "killed").slice(0, 15);
  const accepts = pastOutcomes.filter((o) => o.outcome === "accepted").slice(0, 15);
  if (kills.length === 0 && accepts.length === 0) return BASE_SYSTEM_PROMPT;

  const lines: string[] = [];
  if (kills.length > 0) {
    lines.push("Recent operator **kills** (avoid patterns like these):");
    for (const k of kills) {
      const pair = k.pair ? ` [${k.pair}]` : "";
      lines.push(`  - ${k.reason.trim()}${pair}`);
    }
  }
  if (accepts.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Recent operator **accepts** (favor patterns like these):");
    for (const a of accepts) {
      const pair = a.pair ? ` [${a.pair}]` : "";
      lines.push(`  - ${a.reason.trim()}${pair}`);
    }
  }
  return `${BASE_SYSTEM_PROMPT}

${lines.join("\n")}`;
}

export async function recommendCrossPosts(params: {
  title: string | null;
  contentBody: string | null;
  sourcePlatform: string;
  sourcePostType: string;
  sourceAccountHandle: string | null;
  brand: string | null;
  publishedDate: string | null;
  viewsAt1h: number | null;
  velocityRatio: number | null;
  hasVideo?: boolean;
  hasImage?: boolean;
  mediaCount?: number;
  candidates: CandidateTarget[];
  pastOutcomes?: PastOutcome[];
}): Promise<RecommendResult> {
  if (params.candidates.length === 0) {
    return { proposals: [], isFallback: false };
  }

  const body = params.contentBody?.trim() ?? "";
  if (!body && !params.hasVideo && !params.hasImage) {
    // No content and no media — nothing to cross-post.
    return { proposals: [], isFallback: false };
  }

  const client = new Anthropic();

  const candidateLines = params.candidates.map(
    (c, i) =>
      `  ${i + 1}. target_account_id=${c.targetAccountId}  target_post_type=${c.postType}  @${c.handle} on ${c.platform}${
        c.voiceSample ? `\n       recent voice: "${c.voiceSample.slice(0, 180).replace(/\s+/g, " ")}"` : ""
      }`
  );

  const velocityLine =
    params.viewsAt1h != null && params.velocityRatio != null
      ? `Velocity: ${params.viewsAt1h.toLocaleString()} views at ~1h (${params.velocityRatio.toFixed(1)}× this account+post-type's typical 1h pace)`
      : `Velocity: unknown`;

  const userMessage = [
    `Source account handle: ${params.sourceAccountHandle ?? "(unknown)"}`,
    `Source platform / post type: ${params.sourcePlatform} / ${params.sourcePostType}`,
    `Brand: ${params.brand ?? "(none)"}`,
    `Originally published: ${params.publishedDate ?? "(unknown)"}`,
    velocityLine,
    `Media on source: ${formatMedia(params)}`,
    `Title: "${params.title ?? "(none)"}"`,
    ``,
    `Body:\n"""\n${body.slice(0, MAX_BODY_CHARS)}${
      body.length > MAX_BODY_CHARS ? "…" : ""
    }\n"""`,
    ``,
    `Candidate targets (format-compatible with the source; pick from these exactly):`,
    ...candidateLines,
    ``,
    `Return proposals for the targets where this post would work as-is. Call submit_proposals exactly once.`,
  ].join("\n");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(params.pastOutcomes),
      tools,
      tool_choice: { type: "tool", name: "submit_proposals" },
      messages: [{ role: "user", content: userMessage }],
    });

    for (const block of response.content) {
      if (block.type !== "tool_use" || block.name !== "submit_proposals") continue;
      const input = block.input as {
        proposals?: Array<{
          target_account_id?: string;
          target_post_type?: string;
          confidence?: number;
          reasoning?: string;
        }>;
      };
      const raw = input.proposals ?? [];
      const validCandidates = new Map(
        params.candidates.map((c) => [`${c.targetAccountId}:${c.postType}`, c])
      );
      const proposals: Proposal[] = [];
      for (const p of raw) {
        if (
          typeof p.target_account_id !== "string" ||
          typeof p.target_post_type !== "string" ||
          typeof p.confidence !== "number" ||
          typeof p.reasoning !== "string" ||
          !p.reasoning.trim()
        ) {
          continue;
        }
        const key = `${p.target_account_id}:${p.target_post_type}`;
        if (!validCandidates.has(key)) continue; // Model hallucinated a target.
        const conf = Math.max(0, Math.min(100, Math.round(p.confidence)));
        proposals.push({
          targetAccountId: p.target_account_id,
          targetPostType: p.target_post_type,
          confidence: conf,
          reasoning: p.reasoning.trim(),
        });
      }
      return { proposals, isFallback: false };
    }

    return {
      proposals: [],
      isFallback: true,
      fallbackReason: "no submit_proposals tool call",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { proposals: [], isFallback: true, fallbackReason: message };
  }
}
