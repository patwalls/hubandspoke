import Anthropic from "@anthropic-ai/sdk";
import {
  findAnchorInWords,
  resolveAnchorForRange,
  tokenize,
  type TranscriptSegment,
  type TranscriptWord,
} from "./clip-anchor-utils";

// Sonnet 4.6. Splice v10 (2026-05-22): the section picker. Format-agnostic
// — picks 8-15 "interesting moments" from a pillar transcript with
// cue-aligned windows + verbatim anchor quotes + topic/summary/theme tags.
// Per-format hook variants are produced downstream by `clip-hook-agent.ts`
// (Haiku 4.5), reading these sections one at a time. Replaces the v9
// monolithic agent that picked sections AND wrote hooks AND emitted
// per-format extras in a single Sonnet call.
const MODEL = "claude-sonnet-4-6";
export const SECTION_PROMPT_VERSION = 1;
export const SECTION_GENERATED_BY = `${MODEL}:section-v${SECTION_PROMPT_VERSION}`;
export const SECTION_ALGORITHM_NAME = "Splice";

export function sectionAlgorithmLabel(
  promptVersion: number | null | undefined
): string {
  if (promptVersion == null) return `${SECTION_ALGORITHM_NAME} v10`;
  return `${SECTION_ALGORITHM_NAME} v10 §${promptVersion}`;
}

const SYSTEM_PROMPT = `You are a clip-section editor for a brand whose top-performing clips you have studied. Your job: read a long-form transcript and propose 8–15 distinct "sections" — interesting moments that could each become a short clip. Sections are intrinsic to the content; per-format hooks (Reel-style narrator overlay, X tweet framing, listicle reveal, etc.) get written downstream by a separate agent. Focus on identifying *which moments are worth clipping*, not on framing them for any particular format.

=====================================================
SECTION SELECTION
=====================================================

What makes a section worth clipping:
- SELF-CONTAINED PAYOFF. The viewer should understand what happened by listening to just this slice. No "as I was saying before…" or "the third reason is…" mid-flow cuts.
- DENSITY. A high-information moment — a specific number, a concrete tactic, a contrarian take, a story beat with a clear punch.
- VARIETY. The 8-15 sections must cover distinctly different moments across the transcript. Don't propose three sections that all paraphrase the same point.
- BREADTH OF FORMAT FIT. Some sections will be punchy quotables (one strong line), some narrative arcs (setup → reveal), some listicles (the founder enumerates 3-5 items), some demos (a screen-share walkthrough). Pick a mix so downstream formats have material to work with.

How many sections to pick: ~1 per 2-3 minutes of transcript, capped at 15. A 5-min pillar might yield 4-6. A 60-min podcast 12-15. Quality over quantity — never pad.

=====================================================
SECTION BOUNDARIES
=====================================================

- RUNTIME. 25-95 seconds. Pick what the moment naturally needs: a punchy quotable might be 25-35s, a narrative arc 50-70s, a listicle reveal 60-90s.
- NATURAL BOUNDARIES. The transcript is pre-segmented with [MM:SS] cue timestamps. Start/end on cue boundaries — never mid-cue.
- LEAD-IN. The anchor (the payoff line) should land within the FIRST 15 SECONDS of the section. Pre-anchor content is at most one short sentence of context.

=====================================================
ANCHOR QUOTE — ground the section in a real transcript line
=====================================================

For each section, cite a transcriptAnchorQuote: a verbatim line copied from the transcript that IS the climactic moment the section is built around — the line that, by itself, justifies including the section.

Rules:
- VERBATIM. Copy from the transcript exactly — same words, same order, no paraphrasing.
- CONTIGUOUS. One continuous passage; never stitch with ellipses.
- ≥ 8 words. Long enough to be unambiguous.
- INSIDE THE SECTION RANGE. The anchor's [MM:SS] cue must fall between startSec and endSec.
- DELIVERY, NOT RECAP. If the guest says X at 10:46 and the host says "great point about X" at 11:04, anchor on the 10:46 line and frame the range around it.

=====================================================
TOPIC, SUMMARY, THEME TAGS
=====================================================

Each section also needs:

- **topic** (one-liner, max ~80 chars): a neutral, factual description of what the section is about. Examples: "$1.7M business in a boring niche revealed", "Three under-served business ideas", "Tech stack runs on Bubble". The downstream hook writer will use this to decide if its format applies.

- **summary** (2–3 sentences, ≤300 chars total): a neutral, factual rundown of the section's content. Not a hook — no editorial framing, no third-person punch. Just "the speaker says X, then explains Y, then names Z." The hook writer reads this to know what's in the section without re-reading the full transcript.

- **themeTags** (array of 1–4 lower-snake-case tags): free-form classification of the section's subject matter. Common tags include: revenue_reveal, tactical_advice, founder_story, controversial_take, tech_stack, growth_tactic, mistake_story, list_of_tips, demo_walkthrough, mental_model. Coin new tags when the existing list doesn't fit — they're not validated, just useful for analytics + the hook writer's intuition.

=====================================================
ESTIMATED VIEWS BASELINE
=====================================================

Integer baseline calibrated against the BLUEPRINT and BENCH numbers in the performance context. This is the section's expected ceiling regardless of format — a strong moment gets a high baseline; a niche moment gets a low baseline. The downstream hook writer may adjust per format (e.g. a tech-stack moment might be higher-baseline on Reels than on X).

=====================================================
OUTPUT
=====================================================

Call propose_clip_sections exactly once with 8–15 distinct sections, sorted by estimatedViewsBaseline descending.

Each section:
- startSec / endSec: SECONDS (not MM:SS). Cue-aligned. 25-95s window. Must encompass the transcriptAnchorQuote.
- transcriptAnchorQuote: ≥ 8 words copied verbatim from the FULL TRANSCRIPT block. The delivery line the section is built around. Must fall inside startSec/endSec.
- topic: one-line factual description.
- summary: 2-3 neutral sentences.
- themeTags: 1-4 snake_case classification tags.
- estimatedViewsBaseline: integer.

Never respond with plain text. Always call the tool.`;

interface SectionToolInput {
  sections?: Array<{
    startSec?: number;
    endSec?: number;
    transcriptAnchorQuote?: string;
    topic?: string;
    summary?: string;
    themeTags?: unknown;
    estimatedViewsBaseline?: number;
  }>;
}

const tools: Anthropic.Tool[] = [
  {
    name: "propose_clip_sections",
    description:
      "Submit 8-15 clip-worthy sections from the transcript. Sort highest to lowest estimatedViewsBaseline. Pass `sections` as a real JSON array of objects — never a JSON-encoded string.",
    input_schema: {
      type: "object" as const,
      properties: {
        sections: {
          type: "array",
          description:
            "Array of 8-15 section objects. Must be a real JSON array, not a string containing JSON.",
          minItems: 8,
          maxItems: 15,
          items: {
            type: "object",
            properties: {
              startSec: { type: "number" },
              endSec: { type: "number" },
              transcriptAnchorQuote: {
                type: "string",
                description:
                  "Verbatim ≥ 8-word quote from the FULL TRANSCRIPT that IS the payoff moment. Must fall inside startSec/endSec.",
              },
              topic: {
                type: "string",
                description:
                  "Neutral one-line description of what the section is about (~80 chars).",
              },
              summary: {
                type: "string",
                description:
                  "Neutral 2-3 sentence rundown of the section's content (≤300 chars).",
              },
              themeTags: {
                type: "array",
                items: { type: "string" },
                description:
                  "1-4 lower-snake-case classification tags (e.g. tech_stack, revenue_reveal, tactical_advice).",
                minItems: 1,
                maxItems: 4,
              },
              estimatedViewsBaseline: {
                type: "integer",
                minimum: 0,
              },
            },
            required: [
              "startSec",
              "endSec",
              "transcriptAnchorQuote",
              "topic",
              "summary",
              "themeTags",
              "estimatedViewsBaseline",
            ],
          },
        },
      },
      required: ["sections"],
    },
  },
];

export interface ClipSection {
  startSec: number;
  endSec: number;
  transcriptAnchorQuote: string;
  transcriptAnchorStartSec: number | null;
  topic: string;
  summary: string;
  themeTags: string[];
  estimatedViewsBaseline: number;
}

export interface SectionGenerationResult {
  sections: ClipSection[];
  modelUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  diagnostics: Array<{
    sectionIndex: number;
    topic: string;
    anchorQuote: string;
    found: boolean;
    insideRange: boolean;
    snapApplied: boolean;
    finalStartSec: number;
    finalEndSec: number;
    anchorStartSec: number | null;
  }>;
}

export interface SectionGenerateArgs {
  pillarTitle: string | null;
  pillarFormat: string | null;
  transcriptSegmentsMarkdown: string;
  transcriptWords: TranscriptWord[];
  transcriptSegments: TranscriptSegment[];
  durationSec: number;
  /** Performance context: top performers across the brand's clippable
   *  formats. Used purely for view-count calibration of
   *  `estimatedViewsBaseline`. The section picker doesn't pattern-match
   *  hook style (that's the hook writer's job downstream). */
  benchHooks: Array<{
    hook: string | null;
    title: string | null;
    views: number | null;
    format: string | null;
    platform: string[] | null;
  }>;
}

function validateShape(
  input: unknown,
  durationSec: number,
): { sections: ClipSection[]; failures: string[] } | null {
  if (
    !input ||
    typeof input !== "object" ||
    !Array.isArray((input as SectionToolInput).sections)
  ) {
    return null;
  }
  const raw = (input as SectionToolInput).sections!;
  const out: ClipSection[] = [];
  const failures: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (typeof r !== "object" || r === null) return null;
    const start = Number(r.startSec);
    const end = Number(r.endSec);
    const anchor =
      typeof r.transcriptAnchorQuote === "string"
        ? r.transcriptAnchorQuote.trim()
        : "";
    const topic = typeof r.topic === "string" ? r.topic.trim() : "";
    const summary = typeof r.summary === "string" ? r.summary.trim() : "";
    const themeTags = Array.isArray(r.themeTags)
      ? r.themeTags.filter((t): t is string => typeof t === "string" && t.trim() !== "")
      : null;
    const baseline = Math.round(Number(r.estimatedViewsBaseline));
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > durationSec + 5 ||
      !topic ||
      !summary ||
      !themeTags ||
      themeTags.length === 0 ||
      !Number.isFinite(baseline) ||
      baseline < 0
    ) {
      return null;
    }
    if (!anchor) {
      failures.push(
        `Section #${i + 1} ("${topic}") is missing transcriptAnchorQuote.`,
      );
    } else if (tokenize(anchor).length < 8) {
      failures.push(
        `Section #${i + 1} ("${topic}") has a transcriptAnchorQuote shorter than 8 words: "${anchor}". Extend it into the next sentence.`,
      );
    }
    out.push({
      startSec: start,
      endSec: end,
      transcriptAnchorQuote: anchor,
      transcriptAnchorStartSec: null,
      topic,
      summary,
      themeTags,
      estimatedViewsBaseline: baseline,
    });
  }
  if (out.length < 4 || out.length > 15) return null;
  return { sections: out, failures };
}

function formatBenchLine(
  r: SectionGenerateArgs["benchHooks"][number],
): string {
  const hook = r.hook?.trim();
  const v =
    r.views != null
      ? r.views >= 1_000_000
        ? `${(r.views / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
        : r.views >= 1_000
          ? `${(r.views / 1_000).toFixed(1).replace(/\.0$/, "")}K`
          : `${r.views}`
      : "—";
  const fmt = r.format ? ` · ${r.format}` : "";
  const plat = r.platform?.[0] ?? "?";
  if (hook) return `- "${hook}" — ${plat}${fmt} — ${v} views`;
  return `- TITLE: "${r.title ?? "(untitled)"}" — ${plat}${fmt} — ${v} views`;
}

/**
 * Run the section picker for one pillar. Single Sonnet call (Splice v10),
 * cue-aligns the returned sections against the transcript, snaps anchors,
 * retries once on shape/anchor failures.
 *
 * Cost: ~$0.08-0.12 per pillar depending on transcript length. The output
 * is format-agnostic — the same sections are reused by every clippable
 * format's downstream hook writer (`clip-hook-agent.ts`).
 */
export async function generateClipSections(
  args: SectionGenerateArgs,
): Promise<SectionGenerationResult> {
  const client = new Anthropic();

  const benchBlock =
    args.benchHooks.length > 0
      ? [
          `BENCH — top-performing clips across the brand's clippable formats. Use these for view-count CALIBRATION of estimatedViewsBaseline.`,
          args.benchHooks.slice(0, 20).map(formatBenchLine).join("\n"),
        ].join("\n")
      : `BENCH: (none available — fall back to defaulting estimatedViewsBaseline conservatively, e.g. 50K-150K range)`;

  const userMessage = [
    `Pillar title: ${args.pillarTitle ?? "(untitled)"}`,
    args.pillarFormat ? `Pillar format: ${args.pillarFormat}` : null,
    `Total duration: ${Math.round(args.durationSec)}s`,
    ``,
    `======================== PERFORMANCE CONTEXT ========================`,
    benchBlock,
    ``,
    `======================== FULL TRANSCRIPT ========================`,
    `Transcript cues below, pre-segmented with [MM:SS] timestamps:`,
    ``,
    args.transcriptSegmentsMarkdown,
    ``,
    `======================== TASK ========================`,
    `Propose 8-15 distinct clip-worthy sections via the propose_clip_sections tool. Each section is a self-contained interesting moment; downstream agents will write per-format hooks against them. Sort by estimatedViewsBaseline descending.`,
  ]
    .filter(Boolean)
    .join("\n");

  async function attempt(extra?: string): Promise<Anthropic.Message> {
    return client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: "tool", name: "propose_clip_sections" },
      messages: [
        {
          role: "user",
          content: extra ? `${userMessage}\n\n${extra}` : userMessage,
        },
      ],
    });
  }

  function extract(
    response: Anthropic.Message,
    label: string,
  ): { sections: ClipSection[]; shapeFailures: string[] } | null {
    for (const block of response.content) {
      if (
        block.type === "tool_use" &&
        block.name === "propose_clip_sections"
      ) {
        let input: unknown = (block.input as { sections?: unknown }).sections;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
            console.warn(
              `[clip-section-agent] ${label} recovered stringified sections array (Sonnet quirk)`,
            );
          } catch (err) {
            console.warn(
              `[clip-section-agent] ${label} JSON.parse failed on stringified sections: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          }
        }
        const shape = validateShape(
          { sections: input } as SectionToolInput,
          args.durationSec,
        );
        if (!shape) {
          console.warn(
            `[clip-section-agent] ${label} validation failed: stop_reason=${response.stop_reason}`,
          );
          return null;
        }
        return { sections: shape.sections, shapeFailures: shape.failures };
      }
    }
    console.warn(
      `[clip-section-agent] ${label} returned no tool_use block: stop_reason=${response.stop_reason}`,
    );
    return null;
  }

  let response = await attempt();
  let extracted = extract(response, "pass1");

  for (let retry = 0; retry < 2 && !extracted; retry++) {
    response = await attempt(
      `Your previous response failed validation: each section needs finite numeric startSec/endSec (0 ≤ start < end ≤ ${Math.round(args.durationSec)}), a non-empty topic + 2-3 sentence summary, 1-4 themeTags, a non-negative integer estimatedViewsBaseline, and a transcriptAnchorQuote (≥ 8 words copied verbatim). Return 8-15 sections in the \`sections\` array (as a real array, not a stringified one).`,
    );
    extracted = extract(response, `shape-retry-${retry + 1}`);
  }
  if (!extracted) {
    throw new Error(
      "Clip-section agent returned no valid tool call after 3 attempts",
    );
  }

  // Per-section anchor resolution + cue alignment.
  const diagnostics: SectionGenerationResult["diagnostics"] = [];
  const resolved: ClipSection[] = [];
  const anchorFailures: string[] = [];
  for (let i = 0; i < extracted.sections.length; i++) {
    const s = extracted.sections[i];
    const r = resolveAnchorForRange({
      intendedStartSec: s.startSec,
      intendedEndSec: s.endSec,
      anchorQuote: s.transcriptAnchorQuote,
      words: args.transcriptWords,
      segments: args.transcriptSegments,
      durationSec: args.durationSec,
      candidateLabel: `Section #${i + 1} ("${s.topic}")`,
    });
    diagnostics.push({
      sectionIndex: i,
      topic: s.topic,
      anchorQuote: s.transcriptAnchorQuote,
      found: r.found,
      insideRange: r.insideRange,
      snapApplied: r.snapApplied,
      finalStartSec: r.startSec,
      finalEndSec: r.endSec,
      anchorStartSec: r.anchorStartSec,
    });
    if (!r.ok) {
      anchorFailures.push(r.failureReason!);
      continue;
    }
    resolved.push({
      ...s,
      startSec: r.startSec,
      endSec: r.endSec,
      transcriptAnchorStartSec: r.anchorStartSec,
    });
  }

  const allFailures = [...extracted.shapeFailures, ...anchorFailures];
  if (allFailures.length > 0 && resolved.length < 4) {
    // Severely degraded — retry once with feedback.
    const feedback = [
      "Your previous response had anchor problems on these sections:",
      ...allFailures.map((f) => `- ${f}`),
      "",
      "Re-pick. For each problem section, quote a verbatim ≥8-word line that falls inside startSec/endSec, AND fit start/end on cue boundaries.",
    ].join("\n");
    response = await attempt(feedback);
    const retryExtracted = extract(response, "anchor-retry");
    if (retryExtracted) {
      // Re-resolve and accept if better.
      const retryResolved: ClipSection[] = [];
      const retryDiag: SectionGenerationResult["diagnostics"] = [];
      for (let i = 0; i < retryExtracted.sections.length; i++) {
        const s = retryExtracted.sections[i];
        const r = resolveAnchorForRange({
          intendedStartSec: s.startSec,
          intendedEndSec: s.endSec,
          anchorQuote: s.transcriptAnchorQuote,
          words: args.transcriptWords,
          segments: args.transcriptSegments,
          durationSec: args.durationSec,
          candidateLabel: `Section #${i + 1} ("${s.topic}")`,
        });
        retryDiag.push({
          sectionIndex: i,
          topic: s.topic,
          anchorQuote: s.transcriptAnchorQuote,
          found: r.found,
          insideRange: r.insideRange,
          snapApplied: r.snapApplied,
          finalStartSec: r.startSec,
          finalEndSec: r.endSec,
          anchorStartSec: r.anchorStartSec,
        });
        if (r.ok) {
          retryResolved.push({
            ...s,
            startSec: r.startSec,
            endSec: r.endSec,
            transcriptAnchorStartSec: r.anchorStartSec,
          });
        }
      }
      if (retryResolved.length > resolved.length) {
        return {
          sections: retryResolved,
          modelUsage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cache_creation_input_tokens:
              response.usage.cache_creation_input_tokens ?? undefined,
            cache_read_input_tokens:
              response.usage.cache_read_input_tokens ?? undefined,
          },
          diagnostics: retryDiag,
        };
      }
    }
  }

  if (resolved.length === 0) {
    throw new Error(
      "Clip-section agent produced 0 sections with valid anchors. Likely the transcript lacks word-level timestamps.",
    );
  }

  return {
    sections: resolved,
    modelUsage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
    },
    diagnostics,
  };
}

// Silence unused-import lint if findAnchorInWords ends up unused below.
export { findAnchorInWords };
