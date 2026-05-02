import Anthropic from "@anthropic-ai/sdk";

// Sonnet 4.6. Prompt V7: require each idea to cite a verbatim transcriptAnchor-
// Quote — the line that DELIVERS the hook's payoff — and validate in code that
// the citation actually falls inside startSec/endSec, snapping the range when
// the model picks timestamps adjacent to (rather than over) the delivery line.
// Fixes the V6 failure mode where the agent landed on a host's recap of the
// guest's point instead of the guest making it.
const MODEL = "claude-sonnet-4-6";
export const PROMPT_VERSION = 7;
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
ANCHOR QUOTE — ground the clip in a real transcript line
=====================================================

The single biggest failure mode of this format is picking timestamps that land on someone DISCUSSING a topic instead of someone DELIVERING it. The host recapping the guest's point ("That's great advice, Evan") is not the same as the guest making the point. Both will surface the same keywords; only one is the moment a viewer needs to see.

For each clip, you must cite a transcriptAnchorQuote: a verbatim line copied from the transcript above that IS the climactic moment your clip is built around — the line that, by itself, justifies the hook.

Rules:
- VERBATIM. Copy from the transcript exactly — same words, same order, no paraphrasing. Punctuation differences are fine; word substitutions are not.
- CONTIGUOUS. The quote is one continuous passage from the transcript — never stitch together phrases from different parts with "..." or ellipses. If you need to point at multiple moments, pick ONE that best captures the payoff.
- ≥ 8 words. Long enough to be unambiguous; short enough to be a single beat. If the delivery line is shorter, extend the quote into the next sentence to hit 8 words.
- INSIDE THE CLIP RANGE. The anchor's [MM:SS] cue must fall between your startSec and endSec. If your range doesn't contain the anchor, you've picked the wrong range — fix the timestamps, not the anchor.
- DELIVERY, NOT RECAP. If the guest says "X" at 10:46 and the host says "great point about X" at 11:04, the anchor is the 10:46 line — and your timestamps must encompass it. The fact that 11:04 is more on-the-nose is the trap; the value to the viewer is the original delivery.

=====================================================
ESTIMATED VIEWS
=====================================================

Integer estimate per idea, calibrated against the BLUEPRINT and BENCH numbers in the performance context. A typical performer lands between the median and top-quartile shown. An S-tier viral clip can reach 3–10× top-quartile. Do not inflate. If nothing in the context broke 500K, do not estimate 2M.

=====================================================
OUTPUT
=====================================================

Call propose_clip_ideas exactly once with 10 distinct ideas, sorted by estimatedViews descending.

Each idea:
- startSec / endSec: SECONDS (not MM:SS). Cue-aligned. Must encompass the transcriptAnchorQuote.
- hook: the narrator overlay line in brand voice. Mirrors a REFERENCE LIBRARY pattern.
- angle: one sentence on the payoff.
- rationale: 2–4 sentences. Scroll-stopping move + emotional payoff + structural mirror to your blueprintAnchorHook.
- estimatedViews: integer.
- blueprintAnchorHook: the EXACT verbatim hook from the REFERENCE LIBRARY whose structure your hook is mirroring. Copy-paste the line.
- transcriptAnchorQuote: ≥ 8 words copied verbatim from the FULL TRANSCRIPT block. The delivery line your clip is built around. Must fall inside startSec/endSec.

Never respond with plain text. Always call the tool.`;

export interface ClipIdea {
  startSec: number;
  endSec: number;
  hook: string;
  angle: string;
  rationale: string;
  estimatedViews: number;
  blueprintAnchorHook: string | null;
  // V7: verbatim transcript line that anchors the clip's payoff. The
  // service layer matches this against the word-level transcript and stores
  // the resulting timestamp in `transcriptAnchorStartSec`. Null only on
  // legacy V5/V6 rows when reconstructed from the DB.
  transcriptAnchorQuote: string;
  // Matched start time for the anchor in the source transcript. Set by
  // resolveAnchor() after generation, before insert. Null if matching
  // failed for some reason (kept for forensics; an idea that lacks a match
  // never makes it past validation).
  transcriptAnchorStartSec: number | null;
}

export interface GenerationResult {
  ideas: ClipIdea[];
  modelUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  // Per-idea anchor-resolution telemetry. Useful for the eval harness; the
  // service layer ignores this when persisting to the DB. Length matches the
  // number of ideas the agent originally proposed (before dropping any whose
  // anchors couldn't be resolved).
  diagnostics: AnchorResolution["diagnostics"];
}

const tools: Anthropic.Tool[] = [
  {
    name: "propose_clip_ideas",
    description:
      "Submit exactly 10 short-form clip ideas derived from the transcript. Sort highest to lowest estimated views. Pass `ideas` as a real JSON array of objects — never a JSON-encoded string.",
    input_schema: {
      type: "object" as const,
      properties: {
        ideas: {
          type: "array",
          description:
            "Array of 10 idea objects. Must be a real JSON array, not a string containing JSON.",
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
              transcriptAnchorQuote: {
                type: "string",
                description:
                  "Verbatim quote (≥ 8 words) copied from the FULL TRANSCRIPT block above that IS the payoff moment of this clip. Must fall inside startSec/endSec. Pick the delivery line, not a recap.",
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
              "transcriptAnchorQuote",
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

// Strip everything except letters, digits, and single spaces. Used by the
// anchor matcher so quotes survive the LLM's punctuation/contraction/elision
// quirks ("you're"/"you are", em-dashes, smart quotes, trailing periods).
function normalizeForFuzzyMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  const n = normalizeForFuzzyMatch(s);
  return n.length === 0 ? [] : n.split(" ");
}

function validateShape(
  ideas: unknown,
  durationSec: number,
  referenceHooks: string[]
): { ideas: ClipIdea[]; failures: string[] } | null {
  if (!Array.isArray(ideas)) return null;
  const refSet = new Set(referenceHooks.map(normalizeForMatch));
  const out: ClipIdea[] = [];
  const failures: string[] = [];
  for (let i = 0; i < ideas.length; i++) {
    const raw = ideas[i];
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const start = Number(r.startSec);
    const end = Number(r.endSec);
    const hook = typeof r.hook === "string" ? r.hook.trim() : "";
    const angle = typeof r.angle === "string" ? r.angle.trim() : "";
    const rationale =
      typeof r.rationale === "string" ? r.rationale.trim() : "";
    const estimatedViews = Math.round(Number(r.estimatedViews));
    const blueprintAnchorRaw =
      typeof r.blueprintAnchorHook === "string"
        ? r.blueprintAnchorHook.trim()
        : "";
    const transcriptAnchorRaw =
      typeof r.transcriptAnchorQuote === "string"
        ? r.transcriptAnchorQuote.trim()
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
    // Blueprint anchor: must match the reference library when one is
    // available; loose otherwise. Same rule as V6.
    let blueprintAnchor: string | null = null;
    if (refSet.size > 0) {
      if (!blueprintAnchorRaw || !refSet.has(normalizeForMatch(blueprintAnchorRaw))) {
        return null;
      }
      blueprintAnchor = blueprintAnchorRaw;
    } else {
      blueprintAnchor = blueprintAnchorRaw || null;
    }
    // Transcript anchor: must be present and ≥ 8 words. The actual
    // verbatim/in-range check happens in resolveAnchors() after the matcher
    // sees the words array — we accumulate failures rather than returning
    // null so the retry prompt can tell the LLM exactly which ideas missed.
    if (!transcriptAnchorRaw) {
      failures.push(
        `Idea #${i + 1} ("${hook}") is missing transcriptAnchorQuote.`
      );
    } else if (tokenize(transcriptAnchorRaw).length < 8) {
      failures.push(
        `Idea #${i + 1} ("${hook}") has a transcriptAnchorQuote shorter than 8 words: "${transcriptAnchorRaw}". Extend it into the next sentence.`
      );
    }
    out.push({
      startSec: start,
      endSec: end,
      hook,
      angle,
      rationale,
      estimatedViews,
      blueprintAnchorHook: blueprintAnchor,
      transcriptAnchorQuote: transcriptAnchorRaw,
      transcriptAnchorStartSec: null,
    });
  }
  if (out.length !== 10) return null;
  return { ideas: out, failures };
}

export interface TranscriptWord {
  word: string;
  startSec: number;
  endSec: number;
}

interface AnchorMatch {
  startSec: number;
  endSec: number;
  matchedText: string;
}

// Locate `quote` inside the word-level transcript via a tokenized contiguous
// substring search. Returns null when no run of words in `words` matches the
// tokenized quote — indicates the LLM hallucinated or paraphrased.
//
// The match is exact on the normalized token stream (lowercased, alpha-num +
// apostrophes only). This is intentionally strict: the prompt asks for
// VERBATIM, and a fuzzy match could let "I felt scared" through when the
// actual line is "I was scared," sliding the timestamps off the intended beat.
//
// Recovery: when the LLM violates the contiguous-quote rule and concatenates
// phrases with "..." (a known mode despite explicit prompt rules), split on
// the ellipsis and try matching each sub-quote — pick the first one that's
// ≥ 8 words and lands a contiguous match. Better to anchor on one real
// passage than reject the entire idea.
export function findAnchorInWords(
  quote: string,
  words: TranscriptWord[],
): AnchorMatch | null {
  const direct = findContiguousMatch(quote, words);
  if (direct) return direct;
  // Fallback: split on "..." (also "…") and try each fragment in turn.
  const fragments = quote
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (fragments.length < 2) return null;
  for (const frag of fragments) {
    if (tokenize(frag).length < 8) continue;
    const m = findContiguousMatch(frag, words);
    if (m) return m;
  }
  return null;
}

function findContiguousMatch(
  quote: string,
  words: TranscriptWord[],
): AnchorMatch | null {
  const needle = tokenize(quote);
  if (needle.length === 0 || words.length === 0) return null;
  // Tokenize the words-array entries the same way; words can carry leading
  // spaces / punctuation from Whisper, so each word may flatten to 0..N
  // tokens. Track the source-word index so we can recover startSec/endSec.
  type IndexedToken = { token: string; wordIdx: number };
  const haystack: IndexedToken[] = [];
  for (let i = 0; i < words.length; i++) {
    const tokens = tokenize(words[i].word);
    for (const t of tokens) haystack.push({ token: t, wordIdx: i });
  }
  if (haystack.length < needle.length) return null;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j].token !== needle[j]) continue outer;
    }
    const startWord = words[haystack[i].wordIdx];
    const endWord = words[haystack[i + needle.length - 1].wordIdx];
    return {
      startSec: startWord.startSec,
      endSec: endWord.endSec,
      matchedText: words
        .slice(haystack[i].wordIdx, haystack[i + needle.length - 1].wordIdx + 1)
        .map((w) => w.word)
        .join("")
        .trim(),
    };
  }
  return null;
}

// Pick a clip [start, end] window aligned to segment boundaries. Returns the
// (startSec, endSec) pair drawn from segment cue boundaries that contains
// the anchor, fits in [25, 95]s, and best matches the LLM's intended pacing
// (anchor at ~70% through the clip — typical setup→payoff arc).
//
// All output timestamps come from real segment boundaries, so:
//   - The audio at startSec is the start of a sentence, not mid-cue.
//   - `buildExcerpt` slicing segments by [start, end] now shows exactly
//     what plays, with no leading/trailing partial segments.
function alignRangeToCues(args: {
  intendedStartSec: number;
  intendedEndSec: number;
  anchorStartSec: number;
  anchorEndSec: number;
  durationSec: number;
  segments: TranscriptSegment[];
}): { startSec: number; endSec: number } | { error: string } {
  const minDuration = 25;
  const maxDuration = 95;
  const intendedDuration = Math.max(
    minDuration,
    Math.min(maxDuration, args.intendedEndSec - args.intendedStartSec),
  );

  // Candidate boundaries for the start: any segment start at or before the
  // anchor (so the anchor stays inside). Treat 0 as a candidate too (some
  // pillars have content from the very first segment that should be
  // includable). Likewise candidate ends are segment ends at or after the
  // anchor end.
  const candidateStarts = new Set<number>();
  const candidateEnds = new Set<number>();
  for (const s of args.segments) {
    if (s.startSec <= args.anchorStartSec) candidateStarts.add(s.startSec);
    if (s.endSec >= args.anchorEndSec) candidateEnds.add(s.endSec);
  }
  if (candidateStarts.size === 0 || candidateEnds.size === 0) {
    return {
      error: `no segments straddle anchor at ${args.anchorStartSec.toFixed(1)}s (have ${args.segments.length} segments)`,
    };
  }

  const anchorMid = (args.anchorStartSec + args.anchorEndSec) / 2;

  let best: {
    startSec: number;
    endSec: number;
    score: number;
  } | null = null;
  for (const start of candidateStarts) {
    if (start < 0) continue;
    for (const end of candidateEnds) {
      const duration = end - start;
      if (duration < minDuration || duration > maxDuration) continue;
      if (end > args.durationSec + 0.5) continue;
      // Score components:
      //   - durationDelta: how far from the LLM's intended duration
      //   - placementDelta: how far the anchor lands from the 70% mark
      //   - durationGravity: tiny pull toward 60s (sweet spot per prompt)
      const durationDelta = Math.abs(duration - intendedDuration);
      const anchorPosition = (anchorMid - start) / duration; // 0..1
      const placementDelta = Math.abs(anchorPosition - 0.7) * duration;
      const durationGravity = Math.abs(duration - 60) * 0.1;
      const score = durationDelta + placementDelta + durationGravity;
      if (best === null || score < best.score) {
        best = { startSec: start, endSec: end, score };
      }
    }
  }

  if (best === null) {
    return {
      error: `no cue-aligned ${minDuration}-${maxDuration}s window contains anchor at ${args.anchorStartSec.toFixed(1)}s`,
    };
  }
  return { startSec: best.startSec, endSec: best.endSec };
}

export interface AnchorResolution {
  ideas: ClipIdea[];
  failures: string[];
  diagnostics: Array<{
    ideaIndex: number; // 0-based
    hook: string;
    quote: string;
    found: boolean;
    insideRange: boolean;
    snapApplied: boolean;
    finalStartSec: number;
    finalEndSec: number;
    anchorStartSec: number | null;
  }>;
}

// Match every idea's transcriptAnchorQuote against the words array. Always
// align the [startSec, endSec] to segment cue boundaries — both when the
// LLM's pick already contains the anchor (so we eliminate mid-cue starts the
// LLM may have produced despite the prompt instruction) and when it doesn't
// (existing behavior). Returns the resolved ideas plus human-readable
// failures suitable for the retry prompt.
export function resolveAnchors(
  ideas: ClipIdea[],
  words: TranscriptWord[],
  segments: TranscriptSegment[],
  durationSec: number,
): AnchorResolution {
  const failures: string[] = [];
  const diagnostics: AnchorResolution["diagnostics"] = [];
  const out: ClipIdea[] = [];
  for (let i = 0; i < ideas.length; i++) {
    const idea = ideas[i];
    const match = findAnchorInWords(idea.transcriptAnchorQuote, words);
    if (!match) {
      failures.push(
        `Idea #${i + 1} ("${idea.hook}") — transcriptAnchorQuote not found verbatim in transcript: "${idea.transcriptAnchorQuote}". Quote a real line from the FULL TRANSCRIPT, word-for-word.`
      );
      diagnostics.push({
        ideaIndex: i,
        hook: idea.hook,
        quote: idea.transcriptAnchorQuote,
        found: false,
        insideRange: false,
        snapApplied: false,
        finalStartSec: idea.startSec,
        finalEndSec: idea.endSec,
        anchorStartSec: null,
      });
      out.push(idea);
      continue;
    }

    const llmInsideRange =
      match.startSec >= idea.startSec && match.endSec <= idea.endSec;
    const aligned = alignRangeToCues({
      intendedStartSec: idea.startSec,
      intendedEndSec: idea.endSec,
      anchorStartSec: match.startSec,
      anchorEndSec: match.endSec,
      durationSec,
      segments,
    });

    if ("error" in aligned) {
      // No cue-aligned window can contain this anchor under the duration
      // envelope. Fall back to the LLM's original range only when the
      // anchor was already inside it; otherwise reject so the agent can
      // retry with feedback.
      if (llmInsideRange) {
        diagnostics.push({
          ideaIndex: i,
          hook: idea.hook,
          quote: idea.transcriptAnchorQuote,
          found: true,
          insideRange: true,
          snapApplied: false,
          finalStartSec: idea.startSec,
          finalEndSec: idea.endSec,
          anchorStartSec: match.startSec,
        });
        out.push({ ...idea, transcriptAnchorStartSec: match.startSec });
      } else {
        failures.push(
          `Idea #${i + 1} ("${idea.hook}") — ${aligned.error}. Re-pick startSec/endSec around the line: "${idea.transcriptAnchorQuote}".`
        );
        diagnostics.push({
          ideaIndex: i,
          hook: idea.hook,
          quote: idea.transcriptAnchorQuote,
          found: true,
          insideRange: false,
          snapApplied: false,
          finalStartSec: idea.startSec,
          finalEndSec: idea.endSec,
          anchorStartSec: match.startSec,
        });
        out.push(idea);
      }
      continue;
    }

    const snapApplied =
      aligned.startSec !== idea.startSec || aligned.endSec !== idea.endSec;
    diagnostics.push({
      ideaIndex: i,
      hook: idea.hook,
      quote: idea.transcriptAnchorQuote,
      found: true,
      insideRange: llmInsideRange,
      snapApplied,
      finalStartSec: aligned.startSec,
      finalEndSec: aligned.endSec,
      anchorStartSec: match.startSec,
    });
    out.push({
      ...idea,
      startSec: aligned.startSec,
      endSec: aligned.endSec,
      transcriptAnchorStartSec: match.startSec,
    });
  }
  return { ideas: out, failures, diagnostics };
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

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface GenerateArgs {
  pillarTitle: string | null;
  pillarFormat: string | null;
  pillarChannels: string[] | null;
  transcriptSegmentsMarkdown: string;
  // Word-level transcript timestamps from Whisper. Required by V7 to locate
  // each idea's transcriptAnchorQuote and snap the clip range around it.
  transcriptWords: TranscriptWord[];
  // Segment-level transcript timestamps from Whisper. Used to snap clip
  // start/end to natural cue boundaries so audio doesn't start mid-sentence
  // and the UI excerpt matches what plays.
  transcriptSegments: TranscriptSegment[];
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
      // 10 ideas × (hook + angle + 2-4 sentence rationale + 8+ word
      // anchor quote + blueprint anchor) easily blows past 4096 on chatty
      // transcripts. Bumping to 8192 leaves comfortable headroom; Sonnet 4.6
      // supports up to 64K. Symptom of being too low was V7 silently failing
      // shape validation because the tool_use JSON was truncated mid-array.
      max_tokens: 8192,
      system: systemPrompt,
      tools,
      tool_choice: { type: "tool", name: "propose_clip_ideas" },
      messages: [
        { role: "user", content: extraNote ? `${userMessage}\n\n${extraNote}` : userMessage },
      ],
    });
  }

  // Track whether the most recent extraction saw a stringified ideas array
  // that we couldn't parse — so the retry feedback can call it out by name.
  // Single-element holder so TS doesn't narrow the type through flow analysis
  // when extractIdeas mutates it across closure boundaries.
  const failureModeRef: { current: "ok" | "stringified-malformed" | "other" } = {
    current: "ok",
  };

  function extractIdeas(
    response: Anthropic.Message,
    label: string,
  ): { ideas: ClipIdea[]; shapeFailures: string[] } | null {
    failureModeRef.current = "other";
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "propose_clip_ideas") {
        const input = block.input as { ideas?: unknown };
        // Sonnet quirk: with deeply-nested tool schemas the model sometimes
        // returns the array as a JSON-encoded STRING instead of a real array
        // (`{"ideas": "[{...}, {...}]"}` rather than `{"ideas": [{...}]}`).
        // The SDK passes it through as a string. Detect, parse, and on parse
        // failure flag for the retry to scold the model specifically.
        let ideasInput: unknown = input.ideas;
        if (typeof ideasInput === "string") {
          try {
            ideasInput = JSON.parse(ideasInput);
            console.warn(
              `[clip-idea-agent] ${label} recovered stringified ideas array (Sonnet quirk): isArray=${Array.isArray(ideasInput)}`,
            );
          } catch (err) {
            console.warn(
              `[clip-idea-agent] ${label} JSON.parse failed on stringified ideas: ${err instanceof Error ? err.message : String(err)}`,
            );
            failureModeRef.current = "stringified-malformed";
          }
        }
        const shape = validateShape(
          ideasInput,
          args.durationSec,
          referenceHooks,
        );
        if (shape) failureModeRef.current = "ok";
        if (!shape) {
          // Diagnose: when validateShape returns null we lose detail. Log
          // enough that a Heroku log scrape pinpoints the cause (truncation,
          // wrong idea count, blueprint mismatch, anchor verbatim drift).
          const ideaCount = Array.isArray(input.ideas) ? input.ideas.length : -1;
          let firstFailure = "unknown";
          if (Array.isArray(input.ideas)) {
            for (let idx = 0; idx < input.ideas.length; idx++) {
              const item = input.ideas[idx] as Record<string, unknown> | null;
              if (!item || typeof item !== "object") {
                firstFailure = `idea[${idx}] is not an object`;
                break;
              }
              const reasons: string[] = [];
              const start = Number(item.startSec);
              const end = Number(item.endSec);
              if (!Number.isFinite(start) || start < 0) reasons.push(`startSec=${item.startSec}`);
              if (!Number.isFinite(end) || end <= start || end > args.durationSec + 5)
                reasons.push(`endSec=${item.endSec} (duration=${args.durationSec})`);
              if (typeof item.hook !== "string" || !item.hook.trim()) reasons.push("hook empty/non-string");
              if (typeof item.angle !== "string" || !item.angle.trim()) reasons.push("angle empty/non-string");
              if (typeof item.rationale !== "string" || !item.rationale.trim()) reasons.push("rationale empty/non-string");
              const ev = Math.round(Number(item.estimatedViews));
              if (!Number.isFinite(ev) || ev < 0) reasons.push(`estimatedViews=${item.estimatedViews}`);
              if (referenceHooks.length > 0) {
                const bp = typeof item.blueprintAnchorHook === "string" ? item.blueprintAnchorHook.trim() : "";
                const refSet = new Set(referenceHooks.map(normalizeForMatch));
                if (!bp || !refSet.has(normalizeForMatch(bp))) {
                  reasons.push(`blueprintAnchorHook="${bp.slice(0, 60)}…" not in REFERENCE LIBRARY`);
                }
              }
              if (reasons.length > 0) {
                firstFailure = `idea[${idx}]: ${reasons.join("; ")}`;
                break;
              }
            }
          } else {
            firstFailure = `input.ideas is ${typeof input.ideas} (keys: ${Object.keys(input).join(",")})`;
          }
          console.warn(
            `[clip-idea-agent] ${label} validation failed: stop_reason=${response.stop_reason} idea_count=${ideaCount} input_tokens=${response.usage.input_tokens} output_tokens=${response.usage.output_tokens} first_failure=${firstFailure}`,
          );
          return null;
        }
        return { ideas: shape.ideas, shapeFailures: shape.failures };
      }
    }
    console.warn(
      `[clip-idea-agent] ${label} returned no tool_use block: stop_reason=${response.stop_reason}`,
    );
    return null;
  }

  // Pass 1.
  let response = await attempt();
  let extracted = extractIdeas(response, "pass1");

  // Hard validation failure handler — Sonnet's stringification quirk is flaky
  // (~30% rate on some transcripts), so we allow up to 2 retries when we keep
  // seeing stringified-malformed output before giving up.
  const refReminder =
    referenceHooks.length > 0
      ? ` Each idea's blueprintAnchorHook must be the EXACT verbatim text of one of these REFERENCE LIBRARY hooks: ${referenceHooks
          .map((h) => `"${h}"`)
          .join(", ")}.`
      : "";

  for (let retry = 0; retry < 2 && !extracted; retry++) {
    const feedback =
      failureModeRef.current === "stringified-malformed"
        ? `Your previous response passed the \`ideas\` argument as a JSON-encoded STRING with malformed JSON inside. The tool requires \`ideas\` to be a real JSON ARRAY of 10 objects — pass it directly as an array, not as a string. Each idea object needs: numeric startSec/endSec (0 ≤ start < end ≤ ${Math.round(args.durationSec)}), hook, angle, rationale, integer estimatedViews, blueprintAnchorHook, transcriptAnchorQuote (≥ 8 words verbatim from the transcript).${refReminder}`
        : `Your previous response failed validation: each idea needs finite numeric startSec/endSec (seconds, 0 ≤ start < end ≤ ${Math.round(args.durationSec)}), non-empty hook/angle/rationale, a non-negative integer estimatedViews, a blueprintAnchorHook, and a transcriptAnchorQuote (≥ 8 words copied verbatim from the FULL TRANSCRIPT block).${refReminder} Return exactly 10 ideas in the \`ideas\` array (as a real array, not a stringified one).`;
    response = await attempt(feedback);
    extracted = extractIdeas(response, `shape-retry-${retry + 1}`);
  }

  if (!extracted) {
    throw new Error("Clip-idea agent returned no valid tool call after 3 attempts");
  }

  // Pass 2: resolve anchors against the word-level transcript. Snap ranges
  // when needed; collect failures for ideas whose anchors are missing or
  // unfixable. If we have any anchor failures (or any shape-level
  // anchor-too-short complaints), re-prompt once with idea-specific feedback.
  let resolved = resolveAnchors(
    extracted.ideas,
    args.transcriptWords,
    args.transcriptSegments,
    args.durationSec,
  );
  const allAnchorFailures = [...extracted.shapeFailures, ...resolved.failures];

  if (allAnchorFailures.length > 0) {
    const feedback = [
      "Your previous response had anchor problems on these ideas:",
      ...allAnchorFailures.map((f) => `- ${f}`),
      "",
      "Return all 10 ideas again. For each problem idea, EITHER quote a real verbatim transcript line that falls inside startSec/endSec, OR adjust startSec/endSec so they encompass the anchor line. The anchor must be the moment the hook's premise is DELIVERED, not where it's recapped or referenced.",
    ].join("\n");
    response = await attempt(feedback);
    const retryExtracted = extractIdeas(response, "anchor-retry");
    if (retryExtracted) {
      const retryResolved = resolveAnchors(
        retryExtracted.ideas,
        args.transcriptWords,
        args.transcriptSegments,
        args.durationSec,
      );
      const retryFailures = [
        ...retryExtracted.shapeFailures,
        ...retryResolved.failures,
      ];
      // Accept the retry only if it strictly beats the first pass — otherwise
      // we'd be replacing one bad batch with another.
      if (retryFailures.length < allAnchorFailures.length) {
        extracted = retryExtracted;
        resolved = retryResolved;
      }
    }
  }

  // Drop any ideas that still failed (unresolved anchor or unsnappable
  // out-of-range anchor) — better to ship 8 valid clips than one with a
  // hallucinated anchor. The service layer doesn't currently require exactly
  // 10; the eval harness reads `diagnostics` to see what was dropped.
  const validIdeas: ClipIdea[] = [];
  for (let i = 0; i < resolved.ideas.length; i++) {
    const diag = resolved.diagnostics[i];
    if (diag.found && (diag.insideRange || diag.snapApplied)) {
      validIdeas.push(resolved.ideas[i]);
    }
  }

  // If every idea got dropped, throw a clear error rather than handing back
  // an empty array (which would crash the downstream insert with a Drizzle
  // "values() must be called with at least one value" error). Surfaces the
  // failure to the API caller / Heroku logs in a debuggable way.
  if (validIdeas.length === 0) {
    const notFound = resolved.diagnostics.filter((d) => !d.found).length;
    const outOfRange = resolved.diagnostics.filter(
      (d) => d.found && !d.insideRange && !d.snapApplied,
    ).length;
    throw new Error(
      `Clip-idea agent produced 0 ideas with valid anchors (not_found=${notFound}, unsnappable=${outOfRange}). Likely the transcript lacks word-level timestamps for V7 anchor matching.`,
    );
  }

  return {
    ideas: validIdeas,
    modelUsage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
    },
    diagnostics: resolved.diagnostics,
  };
}
