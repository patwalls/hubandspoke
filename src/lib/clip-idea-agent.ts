import Anthropic from "@anthropic-ai/sdk";

// Sonnet 4.6 for creative judgment. Prompt V5: performance context split into
// BLUEPRINT (top in-format clips with full anatomy — hook, caption, opening
// transcript, engagement) and BENCH (broader short-form winners, single-line
// for view-count calibration). Rationales must cite a specific blueprint row.
const MODEL = "claude-sonnet-4-6";
export const PROMPT_VERSION = 5;
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
RATIONALE — WHY THIS CLIP WILL GO VIRAL
=====================================================

The rationale is the case for virality. This is the single most important thinking you'll do after picking the hook: an editor will read it to decide whether to ship the clip, so make it load-bearing, not padding.

Frame the rationale around three things, in 2–4 tight sentences:

1. The scroll-stopping move — what specifically about the FIRST FIVE WORDS makes a viewer pause? (Specific number, contrarian claim, vulnerability, curiosity gap, etc. Name the pattern.)
2. The emotional payoff — what does the viewer feel or learn by the end? This is what they'll screenshot or comment on.
3. The brand-proof calibration — cite a SPECIFIC BLUEPRINT row by its hook (verbatim or near-verbatim) and view count. The BLUEPRINT section gives you the full anatomy of clips that have actually gone viral on this brand; pattern-match against it. "Anchored to BLUEPRINT row 'Bro simply rebuilt Skype and now makes \$14K/month' (233K views) — same curiosity-gap + specific-number compression" is a strong calibration. Generic "this fits the brand" is not.

Lead with the strongest of those three. Be concrete. Say "$39 of $40K is profit is a jaw-dropping verbatim stat" — not "this clip has strong retention potential." If you can't articulate a specific reason this will outperform the brand's median, the clip probably won't.

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
- rationale: 2–4 sentences on WHY this clip will go viral, following the RATIONALE section above — scroll-stopping move, emotional payoff, and a concrete brand-proof calibration vs. a top-performer in the performance context.
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
  // Verbatim opening of the short, when we have it. Populated by the
  // hook-extract sweep (or copied from clip_ideas.hook on promotion). Titles
  // for Notion-synced / cross-posted items are promotional, not hooks — prefer
  // this field when present.
  hook?: string | null;
}

export interface BlueprintRow extends PerfRow {
  // V5 additions — the rich anatomy block. Any field can be null; the
  // formatter renders only the lines whose source field is non-empty.
  contentBody?: string | null;        // caption (the text actually posted alongside the video)
  coverDescription?: string | null;   // vision-extract one-line read of the poster image
  likes?: number | null;
  comments?: number | null;
  publishedDate?: string | null;
  openingTranscript?: string | null;  // first ~25s of the reel's own transcript
}

export interface GenerateArgs {
  pillarTitle: string | null;
  pillarFormat: string | null;
  pillarChannels: string[] | null;
  transcriptSegmentsMarkdown: string;
  durationSec: number;
  derivatives: PerfRow[];     // short-form derivatives of THIS pillar
  blueprint: BlueprintRow[];  // top in-format performers — full anatomy (V5)
  bench: PerfRow[];           // broader short-form winners — light single-line
}

const SHORT_PLATFORMS_LABELS = ["YouTube Shorts", "Instagram Reel", "TikTok"];

function pickShortPlatform(platform: string[] | null | undefined): string {
  return (
    platform?.find((p) => SHORT_PLATFORMS_LABELS.includes(p)) ??
    platform?.[0] ??
    "?"
  );
}

function compactNumber(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toString();
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function formatPerfRow(r: PerfRow): string {
  const platform = pickShortPlatform(r.platform);
  const views = r.views != null ? `${r.views.toLocaleString()} views` : "—";
  const fmt = r.format ? ` · ${r.format}` : "";
  const hook = r.hook?.trim();
  if (hook) {
    return `- HOOK: "${hook}" — ${platform}${fmt} — ${views}`;
  }
  // Fall back to title with a marker so the LLM knows this isn't a verified
  // opening line — usually a promotional title, not the hook the viewer heard.
  return `- TITLE: "${r.title ?? "(untitled)"}" — ${platform}${fmt} — ${views}`;
}

function formatBlueprintRow(r: BlueprintRow): string {
  const platform = pickShortPlatform(r.platform);
  const lines: string[] = [];
  const hook = r.hook?.trim();
  if (hook) {
    lines.push(`- HOOK: "${hook}"`);
  } else {
    lines.push(`- TITLE: "${r.title ?? "(untitled)"}" (no verified hook on file)`);
  }
  const caption = truncate(r.contentBody, 300);
  if (caption) lines.push(`  CAPTION: "${caption}"`);
  const opening = truncate(r.openingTranscript, 1200);
  if (opening) lines.push(`  OPENING (first 25s of reel transcript): "${opening}"`);
  const cover = truncate(r.coverDescription, 200);
  if (cover) lines.push(`  COVER: ${cover}`);
  // Stats line — always show views; add likes/comments/published when present.
  const statsParts: string[] = [];
  const v = compactNumber(r.views);
  if (v) statsParts.push(`${v} views`);
  const l = compactNumber(r.likes);
  if (l) statsParts.push(`${l} likes`);
  const c = compactNumber(r.comments);
  if (c) statsParts.push(`${c} comments`);
  if (r.publishedDate) statsParts.push(`published ${r.publishedDate}`);
  if (statsParts.length > 0) {
    lines.push(`  STATS: ${platform} · ${statsParts.join(" · ")}`);
  }
  if (r.format) lines.push(`  FORMAT: ${r.format}`);
  return lines.join("\n");
}

export async function generateClipIdeas(
  args: GenerateArgs
): Promise<GenerationResult> {
  const client = new Anthropic();

  const derivativesBlock =
    args.derivatives.length > 0
      ? [
          `DERIVATIVES OF THIS PILLAR (clips already made from this same long-form video, with actual view counts). Lines prefixed HOOK: show the verbatim opening line of each short; lines prefixed TITLE: fall back to the post title because no hook is on file — treat those as weaker signal.`,
          args.derivatives.map(formatPerfRow).join("\n"),
        ].join("\n")
      : `DERIVATIVES OF THIS PILLAR: (none yet — this is the first short-form pass.)`;

  const blueprintBlock =
    args.blueprint.length > 0
      ? [
          `BLUEPRINT — the top performers in this brand's primary clip format, with the full anatomy of each: hook, caption, the first ~25 seconds of the reel's own transcript, and engagement. These are the clips that actually went viral on this audience. Pattern-match against them — what makes the hook land, how the caption frames the payoff, how the opening builds momentum. Every clip-idea rationale you propose MUST cite a specific BLUEPRINT row by hook + view count for its brand-proof calibration.`,
          args.blueprint.map(formatBlueprintRow).join("\n"),
        ].join("\n")
      : `BLUEPRINT: (no in-format top performers on file yet — fall back to BENCH below for calibration.)`;

  const benchBlock =
    args.bench.length > 0
      ? [
          `BENCH — broader short-form winners across formats, lighter detail. Use these for view-count CALIBRATION ONLY (what's a realistic top-end on this brand?), not for hook pattern-matching. Lines prefixed HOOK: are verbatim openings; TITLE: rows are promotional titles where the hook isn't on file (weaker signal).`,
          args.bench.map(formatPerfRow).join("\n"),
        ].join("\n")
      : `BENCH: (none available.)`;

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
    blueprintBlock,
    ``,
    benchBlock,
    ``,
    `======================== FULL TRANSCRIPT ========================`,
    `Transcript cues below, pre-segmented with [MM:SS] timestamps:`,
    ``,
    args.transcriptSegmentsMarkdown,
    ``,
    `======================== TASK ========================`,
    `Propose exactly 10 distinct clip ideas via the propose_clip_ideas tool. Hook is everything — every hook must be a verbatim/near-verbatim quote from the transcript. Each rationale must cite a specific BLUEPRINT row by its hook and view count (see RATIONALE rules in the system prompt). Sort by estimatedViews descending; calibrate against the BLUEPRINT and BENCH numbers above.`,
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
