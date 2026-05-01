import Anthropic from "@anthropic-ai/sdk";

// Sonnet 4.6. Prompt V6: drop the verbatim-from-transcript rule (wrong for
// narrated repackage formats), lead the system prompt with a REFERENCE LIBRARY
// of actual sanitized blueprint hooks, and require each idea to declare which
// blueprint row it's structurally mimicking.
const MODEL = "claude-sonnet-4-6";
export const PROMPT_VERSION = 6;
export const GENERATED_BY = `${MODEL}:v${PROMPT_VERSION}`;

// Friendly name for the clip-idea algorithm. Versioned alongside PROMPT_VERSION.
// Surfaced in the panel so operators can tell at a glance which iteration of
// the algorithm produced a given idea — useful when comparing batches across
// prompt revisions.
export const ALGORITHM_NAME = "Splice";

/** Human-readable label for an idea's algorithm version. Pure function of
 *  the row's stored `prompt_version`, so historical rows always render the
 *  algorithm they were actually generated with. */
export function algorithmLabel(promptVersion: number | null | undefined): string {
  if (promptVersion == null) return ALGORITHM_NAME;
  return `${ALGORITHM_NAME} v${promptVersion}`;
}

const SYSTEM_PROMPT_BASE = `You are a short-form video editor for a brand whose viral reels you have studied. Your job: read a long-form transcript and propose 10 standalone short-form clips (Reels, TikToks, YouTube Shorts) that will perform like the brand's existing top hits.

=====================================================
THE HOOK — narrator overlay, NOT a transcript quote
=====================================================

The hook is the line viewers see and/or hear in the first 1–2 seconds. In this brand's primary clip format ("Repackage Section w/ Hook"), the hook is a NARRATOR OVERLAY — written in the brand's voice, painted on screen above the speaker, often voiced over the cold open. It is NOT a verbatim quote from the founder being interviewed.

The hook references what the viewer is about to hear, but it is editorial framing, not transcription. The transcript clip plays UNDER the hook to deliver the payoff.

THE REFERENCE LIBRARY below shows the brand's actual top-performing hooks. Every hook you write must structurally mirror one of those — same point of view, same compression, same energy. If your hook doesn't sound like one of them, rewrite it.

ANTI-PATTERNS — never propose a hook that:

- Begins with first-person introduction: "My name is…", "Hi I'm…", "I'm a founder who…"
- Begins with founder setup or framing: "Let me tell you…", "So basically…", "Going into this…", "What I did was…"
- Is a verbatim transcript quote in the founder's voice (the transcript belongs UNDER the hook, not as the hook)
- Is generic context or wisdom ("You should focus on…", "The key is…")
- Reads like episode 3 of a story rather than a standalone moment

=====================================================
ANGLE
=====================================================

Angle is the one-sentence payoff. If the hook stops the scroll, the angle is what the viewer walks away understanding. Each clip has exactly one angle.

=====================================================
RATIONALE — WHY THIS CLIP WILL GO VIRAL
=====================================================

2–4 sentences. Tight. Frame it around:

1. The scroll-stopping move — what specifically about the FIRST FIVE WORDS makes a viewer pause?
2. The emotional payoff — what does the viewer feel or learn by the end?
3. The brand-proof calibration — your hook must STRUCTURALLY MIRROR the blueprintAnchorHook you've selected. Name the shared pattern explicitly: "Same third-person 'Bro built X' frame as 'Bro built a $1M business in 6-7 hours' (108K views)" beats a vague "fits the brand."

=====================================================
OTHER CLIP CONSTRAINTS
=====================================================

- SELF-CONTAINED. Setup → payoff inside the clip. Watchable with no prior context.
- RUNTIME. 30–75 seconds is the sweet spot. Prefer 45–70s. Under 25s usually has no payoff; over 90s loses retention.
- NATURAL BOUNDARIES. The transcript is pre-segmented with [MM:SS] cue timestamps. Start/end on cue boundaries — never mid-cue.
- VARIETY. The 10 ideas must cover distinctly different moments. No repeated story beats.

=====================================================
ESTIMATED VIEWS
=====================================================

Integer estimate per idea, calibrated against the BLUEPRINT and BENCH numbers in the performance context. A typical performer lands between the median and top-quartile shown. An S-tier viral clip can reach 3–10× top-quartile. Do not inflate. If nothing in the context broke 500K, do not estimate 2M.

=====================================================
OUTPUT
=====================================================

Call propose_clip_ideas exactly once with 10 distinct ideas, sorted by estimatedViews descending.

Each idea:
- startSec / endSec: SECONDS (not MM:SS). Cue-aligned.
- hook: the narrator overlay line in brand voice. Mirrors a REFERENCE LIBRARY pattern.
- angle: one sentence on the payoff.
- rationale: 2–4 sentences. Scroll-stopping move + emotional payoff + structural mirror to your blueprintAnchorHook.
- estimatedViews: integer.
- blueprintAnchorHook: the EXACT verbatim hook from the REFERENCE LIBRARY whose structure your hook is mirroring. Copy-paste the line.

Never respond with plain text. Always call the tool.`;

export interface ClipIdea {
  startSec: number;
  endSec: number;
  hook: string;
  angle: string;
  rationale: string;
  estimatedViews: number;
  blueprintAnchorHook: string | null;
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
              blueprintAnchorHook: {
                type: "string",
                description:
                  "Verbatim hook from the REFERENCE LIBRARY whose structural pattern this idea is mirroring. Copy the line as shown.",
              },
            },
            required: [
              "startSec",
              "endSec",
              "hook",
              "angle",
              "rationale",
              "estimatedViews",
              "blueprintAnchorHook",
            ],
          },
        },
      },
      required: ["ideas"],
    },
  },
];

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function validateIdeas(
  ideas: unknown,
  durationSec: number,
  referenceHooks: string[]
): ClipIdea[] | null {
  if (!Array.isArray(ideas)) return null;
  const refSet = new Set(referenceHooks.map(normalizeForMatch));
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
    const anchorRaw =
      typeof r.blueprintAnchorHook === "string"
        ? r.blueprintAnchorHook.trim()
        : "";
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
    // Soft validation: when we have a reference library, the anchor must
    // match one of its hooks (whitespace/case-insensitive). Without a library
    // (no preferredFormat data for this brand yet), accept any non-empty value.
    let anchor: string | null = null;
    if (refSet.size > 0) {
      if (!anchorRaw || !refSet.has(normalizeForMatch(anchorRaw))) {
        return null;
      }
      anchor = anchorRaw;
    } else {
      anchor = anchorRaw || null;
    }
    out.push({
      startSec: start,
      endSec: end,
      hook,
      angle,
      rationale,
      estimatedViews,
      blueprintAnchorHook: anchor,
    });
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
  overlay?: string | null;            // on-screen burn-in narrator line (V6)
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

// Strip junk from raw `hook` strings before showing them as exemplars to the
// LLM. Sources of contamination seen in production:
//   - Trailing share URLs: "Bro makes $40K/month https://t.co/abc"
//   - Format-name nesting: "Reel → TikTok Video (Reel: Repackage Section w/ Hook (real hook))"
//   - Trailing emoji-only runs
// Returns null if what's left is too short to be useful as an exemplar.
function sanitizeHook(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // 1. Strip format-name prefix wrappers. The hook column sometimes carries
  //    the full notion-style title like "Reel → TikTok Video (Reel: Repackage
  //    Section w/ Hook (actual hook here))". Repeatedly peel `prefix (...)`
  //    layers when prefix matches a format-name shape.
  for (let i = 0; i < 4; i++) {
    const m = s.match(
      /^(?:Reel(?: → (?:TikTok Video|YouTube Shorts))?|TikTok Video|YouTube Shorts|Instagram Reel)[^()]*\((.+)\)\s*$/i
    );
    if (!m) break;
    s = m[1].trim();
  }

  // 2. Drop trailing share URLs.
  s = s.replace(/\s*https?:\/\/\S+\s*$/g, "").trim();

  // 3. Trim trailing emoji + whitespace + ellipsis runs. Don't strip balanced
  //    punctuation like closing parens — they're often meaningful (e.g. names
  //    in the original title: "(Mike Hill)").
  s = s.replace(/[\s…\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u, "").trim();

  // 4. Collapse whitespace (multi-line hooks become one line for the prompt).
  s = s.replace(/\s+/g, " ").trim();

  if (s.length < 8) return null;
  return s;
}

function formatPerfRow(r: PerfRow): string {
  const platform = pickShortPlatform(r.platform);
  const views = r.views != null ? `${r.views.toLocaleString()} views` : "—";
  const fmt = r.format ? ` · ${r.format}` : "";
  const hook = sanitizeHook(r.hook);
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
  const hook = sanitizeHook(r.hook);
  if (hook) {
    lines.push(`- HOOK: "${hook}"`);
  } else {
    lines.push(`- TITLE: "${r.title ?? "(untitled)"}" (no clean hook on file)`);
  }
  const overlay = sanitizeHook(r.overlay);
  if (overlay && overlay !== hook) {
    lines.push(`  OVERLAY (on-screen burn-in): "${overlay}"`);
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

// Build the dynamic REFERENCE LIBRARY block prepended to the system prompt.
// Pulls the top N sanitized blueprint hooks with their view counts. This is
// what anchors the LLM's brand voice — without it, the model falls back to
// generic "patterns that work" thinking.
function buildReferenceLibrary(blueprint: BlueprintRow[]): {
  block: string;
  hooks: string[];
} {
  const cleaned: { hook: string; views: number | null }[] = [];
  for (const row of blueprint) {
    const h = sanitizeHook(row.hook);
    if (!h) continue;
    cleaned.push({ hook: h, views: row.views });
    if (cleaned.length >= 8) break;
  }
  if (cleaned.length === 0) {
    return {
      block: `=====================================================
REFERENCE LIBRARY
=====================================================

(No in-format top performers on file for this brand yet. Use the BENCH section in the user message for view-count calibration, and lean on the format/anti-pattern rules above to write hooks in a third-person observational, scroll-stopping style.)`,
      hooks: [],
    };
  }
  const lines = cleaned.map(({ hook, views }) => {
    const v = compactNumber(views);
    return v ? `- "${hook}" (${v} views)` : `- "${hook}"`;
  });
  const block = `=====================================================
REFERENCE LIBRARY — this brand's top-performing hooks
=====================================================

The single most important reference for your work. Each line below is a hook from a clip that actually went viral on this brand, with its view count. Every hook you propose must structurally mirror one of these — same point of view (third-person observation is dominant), same compression, same energy. The blueprintAnchorHook field on each idea must contain the exact verbatim line you're mirroring, copy-pasted from this list.

${lines.join("\n")}`;
  return { block, hooks: cleaned.map((c) => c.hook) };
}

export async function generateClipIdeas(
  args: GenerateArgs
): Promise<GenerationResult> {
  const client = new Anthropic();

  const { block: refLibraryBlock, hooks: referenceHooks } =
    buildReferenceLibrary(args.blueprint);
  const systemPrompt = `${refLibraryBlock}\n\n${SYSTEM_PROMPT_BASE}`;

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
          `BLUEPRINT — top performers in this brand's primary clip format, with full anatomy. The hooks here are the ones in the REFERENCE LIBRARY above; the additional fields (overlay, caption, opening transcript, cover, engagement) show you HOW the hook is supported. Pattern-match against them — what makes the hook land, how the caption frames the payoff, how the opening builds momentum.`,
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
    `Propose exactly 10 distinct clip ideas via the propose_clip_ideas tool. Each hook must be a narrator overlay line in this brand's voice — STRUCTURALLY MIRROR a hook from the REFERENCE LIBRARY (set blueprintAnchorHook to the exact verbatim line you're mirroring). Avoid first-person founder intros and verbatim transcript quotes — those belong UNDER the hook, not as the hook. Sort by estimatedViews descending; calibrate against the BLUEPRINT and BENCH numbers above.`,
  ]
    .filter(Boolean)
    .join("\n");

  async function attempt(extraNote?: string): Promise<Anthropic.Message> {
    return client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
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
      ideas = validateIdeas(input.ideas, args.durationSec, referenceHooks);
      break;
    }
  }

  if (!ideas) {
    const refReminder =
      referenceHooks.length > 0
        ? ` Each idea's blueprintAnchorHook must be the EXACT verbatim text of one of these REFERENCE LIBRARY hooks: ${referenceHooks
            .map((h) => `"${h}"`)
            .join(", ")}.`
        : "";
    response = await attempt(
      `Your previous response failed validation: each idea needs finite numeric startSec/endSec (seconds, 0 ≤ start < end ≤ ${Math.round(args.durationSec)}), non-empty hook/angle/rationale, a non-negative integer estimatedViews, and a blueprintAnchorHook string.${refReminder} Return exactly 10 ideas.`
    );
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_clip_ideas") {
        const input = block.input as { ideas?: unknown };
        ideas = validateIdeas(input.ideas, args.durationSec, referenceHooks);
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
