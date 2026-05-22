/**
 * Shared anchor-quote resolution + cue-alignment utilities. Used by both
 * the v1 Splice agent (`clip-idea-agent.ts`) and the v2 section-picker /
 * hook-writer agents. The logic is identical across agents — same
 * transcript word matcher, same cue-aligned window picker, same lead-in
 * cap — so it lives here once and is imported wherever needed.
 *
 * History: extracted from `clip-idea-agent.ts` on 2026-05-22 when the
 * Splice pipeline was split into a format-agnostic section picker (v10)
 * + per-format hook writer. The duplication would have rotted fast.
 */

export interface TranscriptWord {
  word: string;
  startSec: number;
  endSec: number;
}

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AnchorMatch {
  startSec: number;
  endSec: number;
  matchedText: string;
}

/**
 * V8 invariant: cap the unprompted lead-in before the anchor at 15s so the
 * payoff lands inside the first ~15s of the clip. Closes the failure mode
 * where the agent picked a 90s window with 60s of unrelated setup before
 * the anchor.
 */
export const MAX_LEAD_IN_SEC = 15;

const MIN_CLIP_DURATION_SEC = 25;
const MAX_CLIP_DURATION_SEC = 95;

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

export function tokenize(s: string): string[] {
  const n = normalizeForFuzzyMatch(s);
  return n.length === 0 ? [] : n.split(" ");
}

export { normalizeForMatch };

/**
 * Locate `quote` inside the word-level transcript via a tokenized
 * contiguous substring search. Returns null when no run of words matches
 * the tokenized quote — indicates the LLM hallucinated or paraphrased.
 *
 * The match is exact on the normalized token stream (lowercased,
 * alpha-num + apostrophes only). This is intentionally strict: the prompt
 * asks for VERBATIM, and a fuzzy match could let "I felt scared" through
 * when the actual line is "I was scared," sliding the timestamps off the
 * intended beat.
 *
 * Recovery: when the LLM violates the contiguous-quote rule and
 * concatenates phrases with "..." (a known mode despite explicit prompt
 * rules), split on the ellipsis and try matching each sub-quote — pick
 * the first one that's ≥ 8 words and lands a contiguous match.
 */
export function findAnchorInWords(
  quote: string,
  words: TranscriptWord[],
): AnchorMatch | null {
  const direct = findContiguousMatch(quote, words);
  if (direct) return direct;
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

/**
 * Pick a clip [start, end] window aligned to segment cue boundaries. The
 * window must contain the anchor, fit in [25, 95]s, and best match the
 * caller's intended pacing (anchor position within the window).
 *
 * Returns segment-boundary timestamps so:
 *   - The audio at startSec is the start of a sentence, not mid-cue.
 *   - Downstream slicing by [start, end] shows exactly what plays.
 */
export function alignRangeToCues(args: {
  intendedStartSec: number;
  intendedEndSec: number;
  anchorStartSec: number;
  anchorEndSec: number;
  durationSec: number;
  segments: TranscriptSegment[];
}): { startSec: number; endSec: number } | { error: string } {
  const minDuration = MIN_CLIP_DURATION_SEC;
  const maxDuration = MAX_CLIP_DURATION_SEC;
  const intendedDuration = Math.max(
    minDuration,
    Math.min(maxDuration, args.intendedEndSec - args.intendedStartSec),
  );

  const minStart = args.anchorStartSec - MAX_LEAD_IN_SEC;
  const candidateStarts = new Set<number>();
  const candidateEnds = new Set<number>();
  for (const s of args.segments) {
    if (s.startSec <= args.anchorStartSec && s.startSec >= minStart) {
      candidateStarts.add(s.startSec);
    }
    if (s.endSec >= args.anchorEndSec) candidateEnds.add(s.endSec);
  }
  // Fallback: if the lead-in cap leaves zero start candidates (happens
  // when the only segment boundary before the anchor is >15s back — long
  // monologues, sparse cues), drop the cap and try again so we don't
  // fail the entire idea over what's a soft preference.
  if (candidateStarts.size === 0) {
    for (const s of args.segments) {
      if (s.startSec <= args.anchorStartSec) candidateStarts.add(s.startSec);
    }
    if (candidateStarts.size > 0) {
      console.warn(
        `clip-anchor-utils: lead-in cap (${MAX_LEAD_IN_SEC}s) left no start candidates for anchor at ${args.anchorStartSec.toFixed(1)}s — falling back to unconstrained candidates`,
      );
    }
  }
  if (candidateStarts.size === 0 || candidateEnds.size === 0) {
    return {
      error: `no segments straddle anchor at ${args.anchorStartSec.toFixed(1)}s (have ${args.segments.length} segments)`,
    };
  }

  const anchorMid = (args.anchorStartSec + args.anchorEndSec) / 2;
  const intendedSpan = args.intendedEndSec - args.intendedStartSec;
  const targetAnchorPosition =
    intendedSpan > 0
      ? Math.max(
          0,
          Math.min(1, (anchorMid - args.intendedStartSec) / intendedSpan),
        )
      : 0.5;

  let best: { startSec: number; endSec: number; score: number } | null = null;
  for (const start of candidateStarts) {
    if (start < 0) continue;
    for (const end of candidateEnds) {
      const duration = end - start;
      if (duration < minDuration || duration > maxDuration) continue;
      if (end > args.durationSec + 0.5) continue;
      const durationDelta = Math.abs(duration - intendedDuration);
      const anchorPosition = (anchorMid - start) / duration;
      const placementDelta =
        Math.abs(anchorPosition - targetAnchorPosition) * duration;
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

/**
 * Generic per-candidate anchor resolution. Both the v1 Splice agent
 * (per ClipIdea) and the v2 section picker (per Section) wrap this:
 *   1. Look up the anchor quote in the word-level transcript.
 *   2. If found, try to align the intended [startSec, endSec] to cue
 *      boundaries containing the anchor.
 *   3. If alignment fails AND the LLM's original range already contains
 *      the anchor, accept the original range (with a `snapApplied=false`
 *      diagnostic). Otherwise fail with a retry-feedback message.
 */
export interface AnchorResolutionResult {
  ok: boolean;
  /** When ok: the final [startSec, endSec] to persist (either snapped to
   *  cues or the original LLM range as a fallback). */
  startSec: number;
  endSec: number;
  /** When ok and anchor was found: the resolved start time of the anchor
   *  quote inside the transcript. */
  anchorStartSec: number | null;
  /** True iff the matcher located the quote verbatim in the words array. */
  found: boolean;
  /** True iff the LLM's original [start, end] already contained the
   *  resolved anchor. */
  insideRange: boolean;
  /** True iff `alignRangeToCues` adjusted the boundaries. */
  snapApplied: boolean;
  /** Human-readable retry feedback for the agent (only set when ok=false). */
  failureReason: string | null;
}

export function resolveAnchorForRange(args: {
  intendedStartSec: number;
  intendedEndSec: number;
  anchorQuote: string;
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  durationSec: number;
  /** Used to format the failure message — e.g. `Idea #3 ("...")` or
   *  `Section "Bo's reveal"`. */
  candidateLabel: string;
}): AnchorResolutionResult {
  const match = findAnchorInWords(args.anchorQuote, args.words);
  if (!match) {
    return {
      ok: false,
      startSec: args.intendedStartSec,
      endSec: args.intendedEndSec,
      anchorStartSec: null,
      found: false,
      insideRange: false,
      snapApplied: false,
      failureReason: `${args.candidateLabel} — transcriptAnchorQuote not found verbatim in transcript: "${args.anchorQuote}". Quote a real line from the FULL TRANSCRIPT, word-for-word.`,
    };
  }

  const llmInsideRange =
    match.startSec >= args.intendedStartSec &&
    match.endSec <= args.intendedEndSec;
  const aligned = alignRangeToCues({
    intendedStartSec: args.intendedStartSec,
    intendedEndSec: args.intendedEndSec,
    anchorStartSec: match.startSec,
    anchorEndSec: match.endSec,
    durationSec: args.durationSec,
    segments: args.segments,
  });

  if ("error" in aligned) {
    // No cue-aligned window can contain this anchor under the duration
    // envelope. Fall back to the LLM's original range only when the anchor
    // was already inside it.
    if (llmInsideRange) {
      return {
        ok: true,
        startSec: args.intendedStartSec,
        endSec: args.intendedEndSec,
        anchorStartSec: match.startSec,
        found: true,
        insideRange: true,
        snapApplied: false,
        failureReason: null,
      };
    }
    return {
      ok: false,
      startSec: args.intendedStartSec,
      endSec: args.intendedEndSec,
      anchorStartSec: match.startSec,
      found: true,
      insideRange: false,
      snapApplied: false,
      failureReason: `${args.candidateLabel} — ${aligned.error}. Re-pick startSec/endSec around the line: "${args.anchorQuote}".`,
    };
  }

  const snapApplied =
    aligned.startSec !== args.intendedStartSec ||
    aligned.endSec !== args.intendedEndSec;
  return {
    ok: true,
    startSec: aligned.startSec,
    endSec: aligned.endSec,
    anchorStartSec: match.startSec,
    found: true,
    insideRange: llmInsideRange,
    snapApplied,
    failureReason: null,
  };
}
