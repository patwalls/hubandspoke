import Anthropic from "@anthropic-ai/sdk";

// Sonnet 4.6 is the right model for creative judgment on this task — haiku
// produced shallower "all the quotable lines in order" lists in informal tests.
// Swap to haiku if cost becomes a concern once we scale past one-off runs.
const MODEL = "claude-sonnet-4-6";
export const PROMPT_VERSION = 1;
export const GENERATED_BY = `${MODEL}:v${PROMPT_VERSION}`;

const SYSTEM_PROMPT = `You are an expert short-form video editor. Given a full transcript of a long-form interview or video, you identify the 10 moments most likely to perform as standalone short-form clips (Reels, TikTok, YouTube Shorts).

What makes a short clip perform:

1. STRONG HOOK. The first 1-2 seconds must stop a scroll. Good hooks lead with:
   - A specific number or claim ("I make $40K/month with one website")
   - A contrarian statement ("having a big strategy is for losers")
   - A question that opens a curiosity gap
   - A vivid emotional beat — surprise, vulnerability, confession

2. SELF-CONTAINED NARRATIVE. Setup → payoff inside the clip. Never start mid-thought or end on a cliffhanger. A viewer watching only this clip (no prior context) should fully understand it.

3. SPECIFICITY. Concrete numbers, names, places, products. Vague wisdom loses to specific stories.

4. QUOTABILITY. Would someone screenshot or tweet this line? The hook should be portable.

5. RUNTIME. 30–75 seconds is the sweet spot. Under 25s usually has no payoff; over 90s loses retention. Prefer 45–70s when in doubt.

6. NATURAL BOUNDARIES. The transcript is pre-segmented into cues with [MM:SS] timestamps. Start and end clips on those cue boundaries — never mid-cue.

7. VARIETY. The 10 ideas must cover distinctly different moments of the video. Do NOT propose multiple variations of the same story beat. Each idea is a different slice.

You will be given:
- Pillar title and context
- Full transcript with [MM:SS] cue timestamps

You must call the propose_clip_ideas tool exactly once with 10 distinct ideas, sorted from highest confidence to lowest.

For each idea:
- startSec / endSec: in whole or fractional SECONDS (not MM:SS). Align to cue boundaries.
- hook: the 1-2 sentence hook the clip opens on. Quote or tightly paraphrase the transcript — the hook is what the viewer will actually hear.
- angle: one sentence describing what this clip is about overall.
- rationale: 1-2 sentences explaining WHY this clip works. Cite the signal (hook type, contrast, quotability, specificity, emotional beat).
- confidence: 0–1. Your estimate of how likely this clip is to perform well on short-form.

Never respond with plain text. Always call the tool.`;

export interface ClipIdea {
  startSec: number;
  endSec: number;
  hook: string;
  angle: string;
  rationale: string;
  confidence: number;
}

export interface GenerationResult {
  ideas: ClipIdea[];
  modelUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const tools: Anthropic.Tool[] = [
  {
    name: "propose_clip_ideas",
    description:
      "Submit exactly 10 short-form clip ideas derived from the transcript. Sorted highest to lowest confidence.",
    input_schema: {
      type: "object" as const,
      properties: {
        ideas: {
          type: "array",
          minItems: 10,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              startSec: { type: "number" },
              endSec: { type: "number" },
              hook: { type: "string" },
              angle: { type: "string" },
              rationale: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: [
              "startSec",
              "endSec",
              "hook",
              "angle",
              "rationale",
              "confidence",
            ],
          },
        },
      },
      required: ["ideas"],
    },
  },
];

function validateIdeas(
  ideas: unknown,
  durationSec: number
): ClipIdea[] | null {
  if (!Array.isArray(ideas)) return null;
  const out: ClipIdea[] = [];
  for (const raw of ideas) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const start = Number(r.startSec);
    const end = Number(r.endSec);
    const hook = typeof r.hook === "string" ? r.hook.trim() : "";
    const angle = typeof r.angle === "string" ? r.angle.trim() : "";
    const rationale =
      typeof r.rationale === "string" ? r.rationale.trim() : "";
    const confidence = Number(r.confidence);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > durationSec + 5 || // small slack for rounding
      !hook ||
      !angle ||
      !rationale ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return null;
    }
    out.push({ startSec: start, endSec: end, hook, angle, rationale, confidence });
  }
  return out.length === 10 ? out : null;
}

export interface GenerateArgs {
  pillarTitle: string | null;
  pillarFormat: string | null;
  pillarChannels: string[] | null;
  transcriptSegmentsMarkdown: string;
  durationSec: number;
}

export async function generateClipIdeas(
  args: GenerateArgs
): Promise<GenerationResult> {
  const client = new Anthropic();

  const userMessage = [
    `Pillar title: ${args.pillarTitle ?? "(untitled)"}`,
    args.pillarFormat ? `Pillar format: ${args.pillarFormat}` : null,
    args.pillarChannels?.length
      ? `Original channels: ${args.pillarChannels.join(", ")}`
      : null,
    `Total duration: ${Math.round(args.durationSec)}s`,
    ``,
    `Full transcript (cues pre-segmented with [MM:SS] timestamps):`,
    ``,
    args.transcriptSegmentsMarkdown,
    ``,
    `Propose exactly 10 distinct clip ideas via the propose_clip_ideas tool. Sort by confidence descending.`,
  ]
    .filter(Boolean)
    .join("\n");

  async function attempt(extraNote?: string): Promise<Anthropic.Message> {
    return client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: "tool", name: "propose_clip_ideas" },
      messages: [
        { role: "user", content: extraNote ? `${userMessage}\n\n${extraNote}` : userMessage },
      ],
    });
  }

  let response = await attempt();
  let ideas: ClipIdea[] | null = null;
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "propose_clip_ideas") {
      const input = block.input as { ideas?: unknown };
      ideas = validateIdeas(input.ideas, args.durationSec);
      break;
    }
  }

  if (!ideas) {
    response = await attempt(
      `Your previous response failed validation: each idea must have finite numeric startSec/endSec (in seconds, 0 ≤ start < end ≤ ${Math.round(args.durationSec)}), non-empty hook/angle/rationale, and a confidence in [0,1]. Return exactly 10 ideas.`
    );
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_clip_ideas") {
        const input = block.input as { ideas?: unknown };
        ideas = validateIdeas(input.ideas, args.durationSec);
        break;
      }
    }
  }

  if (!ideas) {
    throw new Error("Clip-idea agent returned no valid tool call after retry");
  }

  return {
    ideas,
    modelUsage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
    },
  };
}
