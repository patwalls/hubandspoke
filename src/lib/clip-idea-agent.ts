import Anthropic from "@anthropic-ai/sdk";

// Sonnet 4.6 for creative judgment. Prompt V2: dedicated HOOK section,
// verbatim quote requirement, performance grounding, estimatedViews replaces
// the earlier confidence %.
const MODEL = "claude-sonnet-4-6";
export const PROMPT_VERSION = 2;
export const GENERATED_BY = `${MODEL}:v${PROMPT_VERSION}`;

const SYSTEM_PROMPT = `You are an expert short-form video editor. Given a long-form transcript plus examples of what has worked for this brand, you identify the 10 moments most likely to perform as standalone short-form clips (Reels, TikTok, YouTube Shorts).

=====================================================
THE HOOK IS EVERYTHING
=====================================================

The first 1–2 seconds of a short-form clip decide whether the viewer stops scrolling. Hook quality is by far the strongest predictor of performance. Treat it as the #1 selection criterion — a "smart" angle with a weak hook will lose to a mediocre angle with a stopping-power hook.

HOOK RULES:

- The hook must be a VERBATIM or near-verbatim quote from the transcript. Viewers will literally hear these words — do not paraphrase, do not embellish. If the speaker's exact line doesn't work as a hook, this moment is not a clip.
- Start on an attention-stopping line, not a setup sentence. Setup belongs inside the clip, never at the cold open.
- The first 5–8 words must do the work on their own. If someone reads only those words in a feed preview, they should be intrigued.

HOOK PATTERNS THAT WORK:

- Specific number + specific result: "I make $40K/month with one website", "He built 28 apps. They make $10K/month."
- Contrarian claim: "Having a big strategy is for losers", "I cut my ads entirely and the business grew"
- Founder vulnerability: "Two years ago I had just exited a failed business", "I had just quit my job"
- Curiosity gap: "Bro simply rebuilt Skype and now makes $14K/month"
- Before/after compression: "From $6K/month to $40K/month — 75,000 customers"

HOOK ANTI-PATTERNS (do NOT pick these moments):

- Transitional sentences ("So the next thing we did was...")
- Context/setup lines ("Before we get into the numbers...")
- Generic wisdom ("You should really focus on your customers")
- Anything that reads like episode 3 of a story rather than a standalone moment

=====================================================
ANGLE
=====================================================

Angle is the one-sentence payoff the viewer gets. If the hook is the first word, the angle is what they walk away understanding. Every clip has exactly one angle — a clip that tries to deliver two is a clip that delivers zero.

=====================================================
OTHER CLIP CONSTRAINTS
=====================================================

- SELF-CONTAINED NARRATIVE. Setup → payoff inside the clip. Watchable with no prior context.
- RUNTIME. 30–75 seconds is the sweet spot. Prefer 45–70s unless the moment is naturally shorter. Under 25s usually has no payoff; over 90s loses retention.
- NATURAL BOUNDARIES. The transcript is pre-segmented with [MM:SS] cue timestamps. Start and end clips on those cue boundaries — never mid-cue.
- VARIETY. The 10 ideas must cover distinctly different moments of the video. Do NOT propose multiple variations of the same story beat.

=====================================================
ESTIMATED VIEWS
=====================================================

Each idea includes an \`estimatedViews\` integer — your realistic estimate of how many views the clip would earn on its best-fit short-form channel (Instagram Reel / TikTok / YouTube Shorts), assuming standard production and posting.

Calibrate against the PERFORMANCE CONTEXT you'll be given:
- The performance context lists derivatives of this specific pillar + top-performing short-form clips brand-wide, with their actual view counts.
- A typical performer on this brand lands between the median and top-quartile view counts shown in the context.
- An S-tier viral clip can reach 3–10× the top-quartile number.
- Do not inflate. If nothing in the performance context broke 500K views, do not estimate 2M views for a new clip. Be honest — an estimate that's consistently too high is useless.

Return integer views (e.g. \`120000\`, \`45000\`), not strings, not percentages, not ranges.

=====================================================
OUTPUT
=====================================================

Call propose_clip_ideas exactly once with 10 distinct ideas, sorted by estimatedViews descending.

Each idea:
- startSec / endSec: whole or fractional SECONDS (not MM:SS). Align to cue boundaries from the transcript.
- hook: the 1–2 sentence opening line, verbatim or near-verbatim from the transcript. This is what the viewer hears first.
- angle: one sentence describing the clip's payoff.
- rationale: 1–2 sentences explaining WHY this clip will perform. Cite the hook pattern, reference a similar-performing title from the performance context when applicable.
- estimatedViews: integer. Realistic, calibrated against the performance context.

Never respond with plain text. Always call the tool.`;

export interface ClipIdea {
  startSec: number;
  endSec: number;
  hook: string;
  angle: string;
  rationale: string;
  estimatedViews: number;
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
      "Submit exactly 10 short-form clip ideas derived from the transcript. Sort highest to lowest estimated views.",
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
              estimatedViews: { type: "integer", minimum: 0 },
            },
            required: [
              "startSec",
              "endSec",
              "hook",
              "angle",
              "rationale",
              "estimatedViews",
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
    const estimatedViews = Math.round(Number(r.estimatedViews));
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > durationSec + 5 ||
      !hook ||
      !angle ||
      !rationale ||
      !Number.isFinite(estimatedViews) ||
      estimatedViews < 0
    ) {
      return null;
    }
    out.push({ startSec: start, endSec: end, hook, angle, rationale, estimatedViews });
  }
  return out.length === 10 ? out : null;
}

export interface PerfRow {
  title: string | null;
  platform: string[] | null;
  views: number | null;
  format?: string | null;
}

export interface GenerateArgs {
  pillarTitle: string | null;
  pillarFormat: string | null;
  pillarChannels: string[] | null;
  transcriptSegmentsMarkdown: string;
  durationSec: number;
  derivatives: PerfRow[]; // short-form derivatives of THIS pillar
  topPerformers: PerfRow[]; // brand-wide top short-form clips
}

function formatPerfRow(r: PerfRow): string {
  const platform = r.platform?.find((p) =>
    ["YouTube Shorts", "Instagram Reel", "TikTok"].includes(p)
  ) ?? r.platform?.[0] ?? "?";
  const views = r.views != null ? `${r.views.toLocaleString()} views` : "—";
  const fmt = r.format ? ` · ${r.format}` : "";
  return `- "${r.title ?? "(untitled)"}" — ${platform}${fmt} — ${views}`;
}

export async function generateClipIdeas(
  args: GenerateArgs
): Promise<GenerationResult> {
  const client = new Anthropic();

  const derivativesBlock =
    args.derivatives.length > 0
      ? [
          `DERIVATIVES OF THIS PILLAR (clips already made from this same long-form video, with actual view counts):`,
          args.derivatives.map(formatPerfRow).join("\n"),
        ].join("\n")
      : `DERIVATIVES OF THIS PILLAR: (none yet — this is the first short-form pass.)`;

  const topPerformersBlock =
    args.topPerformers.length > 0
      ? [
          `TOP-PERFORMING SHORT-FORM CLIPS BRAND-WIDE (examples of hooks + angles that actually landed for this audience — titles are usually the hook):`,
          args.topPerformers.map(formatPerfRow).join("\n"),
        ].join("\n")
      : `TOP-PERFORMING SHORT-FORM CLIPS BRAND-WIDE: (none available.)`;

  const userMessage = [
    `Pillar title: ${args.pillarTitle ?? "(untitled)"}`,
    args.pillarFormat ? `Pillar format: ${args.pillarFormat}` : null,
    args.pillarChannels?.length
      ? `Original channels: ${args.pillarChannels.join(", ")}`
      : null,
    `Total duration: ${Math.round(args.durationSec)}s`,
    ``,
    `======================== PERFORMANCE CONTEXT ========================`,
    derivativesBlock,
    ``,
    topPerformersBlock,
    ``,
    `======================== FULL TRANSCRIPT ========================`,
    `Transcript cues below, pre-segmented with [MM:SS] timestamps:`,
    ``,
    args.transcriptSegmentsMarkdown,
    ``,
    `======================== TASK ========================`,
    `Propose exactly 10 distinct clip ideas via the propose_clip_ideas tool. Hook is everything — every hook must be a verbatim/near-verbatim quote from the transcript. Sort by estimatedViews descending. Calibrate estimates against the performance context above.`,
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
      `Your previous response failed validation: each idea needs finite numeric startSec/endSec (seconds, 0 ≤ start < end ≤ ${Math.round(args.durationSec)}), non-empty hook/angle/rationale, and a non-negative integer estimatedViews. Return exactly 10 ideas.`
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
