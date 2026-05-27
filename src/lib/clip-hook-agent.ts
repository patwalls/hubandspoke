import Anthropic from "@anthropic-ai/sdk";
import {
  resolveAnchorForRange,
  tokenize,
  type TranscriptSegment,
  type TranscriptWord,
} from "./clip-anchor-utils";

// Haiku 4.5. Splice v10 hook writer (2026-05-22). Reads ONE pre-detected
// section and ONE format's skill section. Decides if the format applies
// (auto-eligibility), and if so writes a format-styled hook + extras for
// that section. Returns `eligible: false` when the section doesn't fit
// the format (e.g. a non-tech-stack section evaluated against the Tech
// Stack format) — no clip_idea row gets inserted in that case.
//
// One call per (section, format) pair. With ~12 sections × 3 formats the
// pipeline is ~36 Haiku calls per pillar (~$0.11 total), parallel via a
// 5-wide semaphore in the service layer.
const MODEL = "claude-haiku-4-5-20251001";
// v2 (2026-05-27): subject-strict eligibility. v1 decided fit on framing and
// would relabel an app-feature demo as a "feature stack" to satisfy the Tech
// Stack format's name; v2 forbids that reframing and matches on the section's
// actual subject. See clip-hook-agent.eval.test.ts.
export const HOOK_PROMPT_VERSION = 2;
export const HOOK_GENERATED_BY = `${MODEL}:hook-v${HOOK_PROMPT_VERSION}`;

const DEFAULT_FORMAT_BLOCK = `FORMAT — narrator-overlay hook, 30–60s vertical Reel.

The hook is a NARRATOR OVERLAY: written in the brand's voice, painted on screen above the speaker, voiced over the cold open. It is NOT a verbatim quote from the founder.

ANTI-PATTERNS: first-person intros ("My name is…"), founder setup ("Let me tell you…"), verbatim transcript quotes, generic wisdom, mid-story cuts.

Runtime sweet spot: 30-60s. Tight list-tease hooks 30-45s; narrative beats 50-60s.`;

const SYSTEM_PROMPT_BASE = `You are a per-format hook writer for a brand whose top-performing clips you have studied. You get ONE section of a long-form pillar (with a verbatim anchor quote + topic + summary) and ONE clippable format's authoring guide.

Your job, in order:

1. DECIDE if THIS format fits THIS section — judged on the section's ACTUAL SUBJECT, never on how cleverly you could reframe it.

   - Some formats are broad ("the founder reveals their $1.7M business" fits both Reel and X). Others declare a NARROW subject — in the FORMAT block, or implied by the format's name (e.g. a "Tech Stack" format, an "X Quotables" format). Read the FORMAT block to learn what subject and shape this format is actually for.
   - For a narrow-subject format, default to \`eligible: false\` UNLESS the section's content clearly and literally IS that subject. Do NOT relabel, stretch, or reframe a section to make it fit. Concretely: a product/app-feature DEMO — the founder walking through what their app DOES for its users ("first you open the calculator, then you log a dose, then you pick an injection site") — is NOT a tech-stack reveal, even though you could call it a "feature stack." Naming the engineering tools/services the product is BUILT ON or RUNS ON ("we use Bubble, Framer for the site, Ghost for content, Postgres") IS. If you notice yourself softening the format's own word to make a section fit, that is the signal to return \`eligible: false\`.
   - The section's \`themeTags\` are a subject hint. When they point away from the format's subject (e.g. \`demo_walkthrough\` or \`revenue_reveal\` against a tech-stack format), scrutinize hard before accepting.
   - \`reason\` must name the SPECIFIC thing in the section that makes the subject match (or not) — grounded in the section's content, not in the framing you'd write. **Be honest** — a non-fit produces a clip the editor just kills.

2. If eligible, WRITE the hook + any format-specific extras the FORMAT block declares. Mirror a REFERENCE LIBRARY pattern. Keep timestamps cue-aligned (you can narrow within the section via tightStartSec/tightEndSec — never widen beyond the section's bounds).

=====================================================
HOOK CONSTRUCTION
=====================================================

The hook follows the FORMAT block's style (narrator overlay vs. third-person framing vs. listicle reveal vs. whatever). Read the FORMAT block carefully and mirror a REFERENCE LIBRARY hook's structural pattern — same point of view, same compression, same energy. Set \`blueprintAnchorHook\` to the EXACT verbatim REFERENCE LIBRARY line you're mirroring (copy-paste the line).

=====================================================
ANGLE + RATIONALE + ESTIMATED VIEWS
=====================================================

- **angle**: one sentence on the payoff — what the viewer walks away understanding.
- **rationale**: 2-4 sentences. Scroll-stopping move (what about the FIRST FIVE WORDS makes a viewer pause?) + emotional payoff + the structural mirror to your blueprintAnchorHook ("Same 'Bro built X' frame as 'Bro built $1M business in 6-7 hours' (108K views)").
- **estimatedViews**: integer, calibrated against the REFERENCE LIBRARY view counts. May exceed or undercut the section's \`estimatedViewsBaseline\` depending on how well this format suits this section.

=====================================================
TIGHT CUTS
=====================================================

The section's [startSec, endSec] is one valid window. If your format wants a tighter cut (e.g. X Quotables prefers 20-40s but the section is 70s), set \`tightStartSec\` / \`tightEndSec\` to narrow within the section. The anchor must still fall inside the tight range. NEVER widen — only narrow.

=====================================================
OUTPUT
=====================================================

Call write_format_hook exactly once. Two paths:

  - INELIGIBLE: { eligible: false, reason: "<one sentence>" }. Skip all other fields.
  - ELIGIBLE: { eligible: true, reason, hook, angle, rationale, estimatedViews, blueprintAnchorHook, transcriptAnchorQuote, tightStartSec?, tightEndSec?, extras? }

\`transcriptAnchorQuote\` must be the section's anchor quote, verbatim (copy from the SECTION block). \`extras\` is required iff the FORMAT block declares an extras-schema; conform to it.

Never respond with plain text. Always call the tool.`;

const tools = (
  extrasSchema: Record<string, unknown> | null,
): Anthropic.Tool[] => {
  const props: Record<string, unknown> = {
    eligible: { type: "boolean" },
    reason: { type: "string", maxLength: 240 },
    hook: { type: "string" },
    angle: { type: "string" },
    rationale: { type: "string" },
    estimatedViews: { type: "integer", minimum: 0 },
    blueprintAnchorHook: {
      type: "string",
      description:
        "EXACT verbatim hook from the REFERENCE LIBRARY whose structure this hook is mirroring. Copy-paste the line.",
    },
    transcriptAnchorQuote: {
      type: "string",
      description: "Verbatim copy of the section's anchor quote (≥ 8 words).",
    },
    tightStartSec: {
      type: "number",
      description:
        "Optional narrower start (within the section). Anchor must still fall inside.",
    },
    tightEndSec: { type: "number" },
  };
  if (extrasSchema && Object.keys(extrasSchema).length > 0) {
    props.extras = {
      type: "object",
      description:
        "Format-specific extras declared by the FORMAT block. Required when eligible.",
      properties: extrasSchema,
      required: Object.keys(extrasSchema),
    };
  }
  return [
    {
      name: "write_format_hook",
      description:
        "Decide whether the format fits the section, and write the hook (with format extras) if it does.",
      input_schema: {
        type: "object" as const,
        properties: props,
        required: ["eligible", "reason"],
      },
    },
  ];
};

export interface HookCandidate {
  eligible: boolean;
  reason: string;
  hook: string | null;
  angle: string | null;
  rationale: string | null;
  estimatedViews: number | null;
  blueprintAnchorHook: string | null;
  transcriptAnchorQuote: string | null;
  transcriptAnchorStartSec: number | null;
  /** Final clip range — either the section's range or the LLM's tighter
   *  narrowing (if it returned valid tightStartSec/tightEndSec). */
  startSec: number;
  endSec: number;
  extras: Record<string, unknown> | null;
}

export interface HookGenerationResult {
  candidate: HookCandidate;
  modelUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface HookGenerateArgs {
  formatName: string;
  /** Extracted `## Clip Idea Generation` skill section. Null falls back
   *  to the default Reels-style block (matches v1 behavior). */
  formatSkillSection: string | null;
  /** Parsed extras-schema from a fenced \`extras-schema\` block inside
   *  the skill section. Null = no extras for this format. */
  extrasSchema: Record<string, unknown> | null;
  /** 5 sanitized top-performing hooks for this format, for the reference
   *  library that anchors `blueprintAnchorHook`. */
  referenceHooks: Array<{ hook: string; views: number | null }>;
  /** The section being evaluated. */
  section: {
    id: string;
    startSec: number;
    endSec: number;
    transcriptAnchorQuote: string;
    transcriptAnchorStartSec: number | null;
    topic: string;
    summary: string;
    themeTags: string[];
    estimatedViewsBaseline: number | null;
    /** Transcript text just for this section's range — saves the writer
     *  from re-reading the full pillar transcript. Pre-formatted with
     *  [MM:SS] cue prefixes. */
    transcriptExcerpt: string;
  };
  /** Word-level transcript (full pillar) for re-resolving the anchor when
   *  the writer narrows via tightStartSec/tightEndSec. */
  transcriptWords: TranscriptWord[];
  transcriptSegments: TranscriptSegment[];
  pillarDurationSec: number;
  /** Test seam: inject a stubbed Anthropic client. Defaults to a real
   *  `new Anthropic()` (reads ANTHROPIC_API_KEY). Mirrors the template in
   *  `services/draft-algorithm/derivative-hook.ts`. */
  client?: Anthropic;
}

function sanitizeHookText(s: string): string | null {
  let t = s.trim();
  if (!t) return null;
  t = t.replace(/\s*https?:\/\/\S+\s*$/g, "").trim();
  t = t
    .replace(/[\s…\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u, "")
    .trim();
  t = t.replace(/\s+/g, " ").trim();
  return t.length >= 8 ? t : null;
}

function formatReferenceLibrary(
  hooks: HookGenerateArgs["referenceHooks"],
): { block: string; allowedHooks: string[] } {
  if (hooks.length === 0) {
    return {
      block: `REFERENCE LIBRARY: (none yet — calibrate hook style against the FORMAT block's guidance. Set blueprintAnchorHook to a brief description of the pattern instead of a verbatim line.)`,
      allowedHooks: [],
    };
  }
  const lines: string[] = [];
  const allowed: string[] = [];
  for (const r of hooks.slice(0, 5)) {
    const h = sanitizeHookText(r.hook);
    if (!h) continue;
    allowed.push(h);
    const v =
      r.views != null
        ? r.views >= 1_000_000
          ? `${(r.views / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
          : r.views >= 1_000
            ? `${(r.views / 1_000).toFixed(1).replace(/\.0$/, "")}K`
            : `${r.views}`
        : null;
    lines.push(v ? `- "${h}" (${v} views)` : `- "${h}"`);
  }
  return {
    block: `REFERENCE LIBRARY — this format's top-performing hooks. Every hook you write must structurally mirror one of these. \`blueprintAnchorHook\` must be the EXACT verbatim line you're mirroring (copy-paste).\n\n${lines.join("\n")}`,
    allowedHooks: allowed,
  };
}

function validate(
  raw: unknown,
  args: HookGenerateArgs,
  allowedHooks: string[],
): HookCandidate | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "tool input was not an object" };
  }
  const r = raw as Record<string, unknown>;
  const eligible = r.eligible === true;
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  if (!reason) return { error: "reason missing" };

  if (!eligible) {
    return {
      eligible: false,
      reason,
      hook: null,
      angle: null,
      rationale: null,
      estimatedViews: null,
      blueprintAnchorHook: null,
      transcriptAnchorQuote: null,
      transcriptAnchorStartSec: null,
      startSec: args.section.startSec,
      endSec: args.section.endSec,
      extras: null,
    };
  }

  const hook =
    typeof r.hook === "string" ? sanitizeHookText(r.hook) ?? "" : "";
  const angle = typeof r.angle === "string" ? r.angle.trim() : "";
  const rationale =
    typeof r.rationale === "string" ? r.rationale.trim() : "";
  const estimatedViews = Math.round(Number(r.estimatedViews));
  const blueprintAnchorRaw =
    typeof r.blueprintAnchorHook === "string"
      ? r.blueprintAnchorHook.trim()
      : "";
  const anchorRaw =
    typeof r.transcriptAnchorQuote === "string"
      ? r.transcriptAnchorQuote.trim()
      : "";
  if (
    !hook ||
    !angle ||
    !rationale ||
    !Number.isFinite(estimatedViews) ||
    estimatedViews < 0 ||
    !anchorRaw
  ) {
    return {
      error:
        "eligible=true but one of hook/angle/rationale/estimatedViews/transcriptAnchorQuote is missing or invalid",
    };
  }
  if (tokenize(anchorRaw).length < 8) {
    return { error: `transcriptAnchorQuote shorter than 8 words` };
  }
  // Blueprint anchor must match the reference library when one exists.
  let blueprintAnchor: string | null = null;
  if (allowedHooks.length > 0) {
    const allowedSet = new Set(
      allowedHooks.map((h) => h.toLowerCase().replace(/\s+/g, " ").trim()),
    );
    const norm = blueprintAnchorRaw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!norm || !allowedSet.has(norm)) {
      return {
        error: `blueprintAnchorHook "${blueprintAnchorRaw.slice(0, 60)}…" not in REFERENCE LIBRARY`,
      };
    }
    blueprintAnchor = blueprintAnchorRaw;
  } else {
    blueprintAnchor = blueprintAnchorRaw || null;
  }

  // Tight range (optional). When present, must be inside the section.
  const tightStartRaw = Number(r.tightStartSec);
  const tightEndRaw = Number(r.tightEndSec);
  let finalStart = args.section.startSec;
  let finalEnd = args.section.endSec;
  if (
    Number.isFinite(tightStartRaw) &&
    Number.isFinite(tightEndRaw) &&
    tightStartRaw >= args.section.startSec &&
    tightEndRaw <= args.section.endSec &&
    tightEndRaw - tightStartRaw >= 20 // minimum clip length
  ) {
    finalStart = tightStartRaw;
    finalEnd = tightEndRaw;
  }

  // Anchor must fall inside the final range. Reuse the shared resolver
  // with the (possibly narrowed) range.
  const anchorRes = resolveAnchorForRange({
    intendedStartSec: finalStart,
    intendedEndSec: finalEnd,
    anchorQuote: anchorRaw,
    words: args.transcriptWords,
    segments: args.transcriptSegments,
    durationSec: args.pillarDurationSec,
    candidateLabel: `Hook for section "${args.section.topic}"`,
  });
  if (!anchorRes.ok) {
    return { error: anchorRes.failureReason ?? "anchor resolution failed" };
  }

  // Extras check.
  let extras: Record<string, unknown> | null = null;
  if (args.extrasSchema && Object.keys(args.extrasSchema).length > 0) {
    const e = r.extras;
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return { error: "extras missing or wrong shape" };
    }
    extras = e as Record<string, unknown>;
    for (const key of Object.keys(args.extrasSchema)) {
      const v = extras[key];
      if (v === undefined || v === null) {
        return { error: `extras.${key} missing` };
      }
      if (Array.isArray(v) && v.length === 0) {
        return { error: `extras.${key} empty array` };
      }
      if (typeof v === "string" && v.trim() === "") {
        return { error: `extras.${key} empty string` };
      }
    }
  }

  return {
    eligible: true,
    reason,
    hook,
    angle,
    rationale,
    estimatedViews,
    blueprintAnchorHook: blueprintAnchor,
    transcriptAnchorQuote: anchorRaw,
    transcriptAnchorStartSec: anchorRes.anchorStartSec,
    startSec: anchorRes.startSec,
    endSec: anchorRes.endSec,
    extras,
  };
}

/**
 * Write a per-format hook for one section. Single Haiku call (cheap),
 * decides eligibility + writes hook or skips. Retries once on shape /
 * anchor validation failure with corrective feedback.
 */
export async function writeFormatHookForSection(
  args: HookGenerateArgs,
): Promise<HookGenerationResult> {
  const client = args.client ?? new Anthropic();

  const formatBlock = args.formatSkillSection
    ? `=====================================================
FORMAT BLOCK — ${args.formatName} (from format Skill)
=====================================================

${args.formatSkillSection.trim()}`
    : `=====================================================
FORMAT BLOCK — ${args.formatName} (default Reels-style fallback)
=====================================================

${DEFAULT_FORMAT_BLOCK}`;

  const refLib = formatReferenceLibrary(args.referenceHooks);

  const systemPrompt = [
    SYSTEM_PROMPT_BASE,
    "",
    formatBlock,
    "",
    refLib.block,
  ].join("\n");

  const userMessage = [
    `SECTION`,
    `topic: ${args.section.topic}`,
    `summary: ${args.section.summary}`,
    `themeTags: ${args.section.themeTags.join(", ")}`,
    `range: ${args.section.startSec.toFixed(1)}–${args.section.endSec.toFixed(1)}s (${Math.round(args.section.endSec - args.section.startSec)}s)`,
    `anchor (verbatim from transcript): "${args.section.transcriptAnchorQuote}"`,
    args.section.estimatedViewsBaseline != null
      ? `picker's view-count baseline: ${args.section.estimatedViewsBaseline.toLocaleString()}`
      : null,
    ``,
    `TRANSCRIPT EXCERPT (this section's cues only):`,
    args.section.transcriptExcerpt,
    ``,
    `TASK: Decide if "${args.formatName}" fits this section. If yes, write the hook + extras. If no, return eligible:false with a one-sentence reason.`,
  ]
    .filter(Boolean)
    .join("\n");

  async function attempt(
    extra?: string,
  ): Promise<Anthropic.Message> {
    return client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools(args.extrasSchema),
      tool_choice: { type: "tool", name: "write_format_hook" },
      messages: [
        {
          role: "user",
          content: extra ? `${userMessage}\n\n${extra}` : userMessage,
        },
      ],
    });
  }

  let response = await attempt();

  function extract(
    resp: Anthropic.Message,
  ): { input: unknown } | null {
    for (const block of resp.content) {
      if (block.type === "tool_use" && block.name === "write_format_hook") {
        return { input: block.input };
      }
    }
    return null;
  }

  let extracted = extract(response);
  let validated:
    | HookCandidate
    | { error: string }
    | null = extracted ? validate(extracted.input, args, refLib.allowedHooks) : null;

  if (!validated || ("error" in validated && !("eligible" in validated))) {
    const reason =
      validated && "error" in validated
        ? validated.error
        : "tool_use block missing";
    response = await attempt(
      `Your previous response failed validation: ${reason}. Re-call write_format_hook with either eligible:false (+ one-sentence reason) OR a full eligible:true object (hook, angle, rationale, integer estimatedViews, blueprintAnchorHook copied verbatim from the REFERENCE LIBRARY, transcriptAnchorQuote ≥8 words verbatim from the transcript excerpt above, and extras conforming to the schema when declared).`,
    );
    extracted = extract(response);
    if (extracted) {
      validated = validate(extracted.input, args, refLib.allowedHooks);
    }
  }

  if (!validated || "error" in validated) {
    // Give up — surface as ineligible so the pipeline continues with the
    // other sections. The worker logs carry the failure reason.
    const reason =
      validated && "error" in validated
        ? `validation failed: ${validated.error}`
        : "no tool_use block";
    console.warn(
      `[clip-hook-agent] section="${args.section.topic}" format="${args.formatName}" giving up: ${reason}`,
    );
    return {
      candidate: {
        eligible: false,
        reason: `agent error: ${reason}`,
        hook: null,
        angle: null,
        rationale: null,
        estimatedViews: null,
        blueprintAnchorHook: null,
        transcriptAnchorQuote: null,
        transcriptAnchorStartSec: null,
        startSec: args.section.startSec,
        endSec: args.section.endSec,
        extras: null,
      },
      modelUsage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cache_read_input_tokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }

  return {
    candidate: validated,
    modelUsage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens:
        response.usage.cache_read_input_tokens ?? undefined,
    },
  };
}
