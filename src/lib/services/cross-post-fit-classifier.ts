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

export interface PastCrossPostKill {
  reason: string;
  /** The target platform of the cross-post that was killed. */
  targetPlatform?: string | null;
}

const tools: Anthropic.Tool[] = [
  {
    name: "mark_good_fit",
    description:
      "Mark this post as a good candidate to cross-post to the specified target platform. Use when the content is self-contained, durable, and fits the target platform's medium and audience.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: {
          type: "string",
          description:
            "One or two sentences explaining why this specific post fits this specific target platform.",
        },
      },
      required: ["reasoning"],
    },
  },
  {
    name: "mark_bad_fit",
    description:
      "Mark this post as a poor cross-post candidate for the specified target platform. Use when the content is tied to a moment, leans on the source platform's framing, is a thin reaction, or — most importantly — its medium (video, long thread, etc.) does not translate to the target platform.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: {
          type: "string",
          description:
            "One or two sentences explaining why this post should not be cross-posted to this target platform. Cite the specific quality (time-sensitive, platform-native, thin reaction, medium mismatch).",
        },
      },
      required: ["reasoning"],
    },
  },
];

const BASE_SYSTEM_PROMPT = `You are judging whether a social post is a good candidate to cross-post to a specific target platform, days or weeks after the original ran.

You will be told the source platform, the target platform, the post's title/body, and what media the source contains (video, image, or none). Your job is to judge fit for that specific target — not fit in the abstract.

Core questions, in order:

1. **Medium fit for the target.** Does the target platform accept and showcase the source's medium? A video belongs on video-first platforms (YouTube, YouTube Shorts, TikTok, Instagram Reels, X). A photo belongs on image-friendly platforms (Instagram, LinkedIn, YouTube Community, Threads, X). A pure text post belongs on text-friendly platforms (Threads, X, LinkedIn, YouTube Community). If the source's medium does not fit the target, mark as bad fit — even if the idea itself is great. Reason explicitly: "the source is a video, but the target is for image/text status updates" (or similar).

2. **Substance and durability.** Is the content self-contained, evergreen, and valuable to a cold viewer? Bad signals: tied to a specific moment (news, launch, earnings, holiday, meme cycle, "today I", "this week"), platform-native framing ("as I tweeted"), thin reactions ("lol", "RIP"), link-only where the payload lives elsewhere.

3. **Audience & tone fit.** Does the tone and topic match what the target platform's audience expects?

The body text is the source of truth. Titles are often truncated or platform-generated.

You must call exactly one tool — never respond with plain text. When genuinely uncertain, lean toward \`mark_bad_fit\`: a false negative means one fewer suggestion; a false positive means a stale or awkward suggestion on the operator's queue.`;

function buildSystemPrompt(pastKills: PastCrossPostKill[] | undefined): string {
  if (!pastKills || pastKills.length === 0) return BASE_SYSTEM_PROMPT;
  const lines = pastKills
    .filter((k) => typeof k.reason === "string" && k.reason.trim().length > 0)
    .slice(0, 10)
    .map((k) => {
      const plat = k.targetPlatform ? ` [→ ${k.targetPlatform}]` : "";
      return `  - ${k.reason.trim()}${plat}`;
    });
  if (lines.length === 0) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

Recent operator rejections of cross-post ideas — each is tagged with the target platform it was killed for. Use these as signal for the kinds of mismatches the operator has already flagged. If the current (source → target) pair is likely to draw a similar rejection, lean toward \`mark_bad_fit\`:
${lines.join("\n")}`;
}

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

export async function classifyCrossPostFit(params: {
  title: string | null;
  contentBody: string | null;
  sourcePlatform: string;
  targetPlatform: string;
  publishedDate: string | null;
  format?: string | null;
  brand?: string | null;
  hasVideo?: boolean;
  hasImage?: boolean;
  mediaCount?: number;
  pastKillReasons?: PastCrossPostKill[];
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
    `Target platform: ${params.targetPlatform}`,
    `Media on source: ${formatMedia(params)}`,
    `Title: "${params.title ?? "(none)"}"`,
    `Format: ${params.format ?? "(none)"}`,
    `Brand: ${params.brand ?? "(none)"}`,
    `Originally published: ${params.publishedDate ?? "(unknown)"}`,
    ``,
    bodySection,
    ``,
    `Judge this as a cross-post candidate for the target platform above. Call exactly one tool.`,
  ].join("\n");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: buildSystemPrompt(params.pastKillReasons),
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
