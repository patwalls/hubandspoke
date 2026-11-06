import {
  findAnchorInWords,
  type TranscriptSegment,
  type TranscriptWord,
} from "./clip-anchor-utils";

/**
 * Clip stitching (2026-11-05). On ~a quarter of hand-edited clips (most of
 * them on tutorial-style brands) editors pull 1–5 extra short moments from
 * minutes away in the source into the clip — the setup a payoff needs, the
 * number that proves it, the demo step it skipped. The section picker now
 * names up to MAX_SUPPORTING_MOMENTS such lines per section as verbatim
 * quotes; this module turns those quotes into cue-aligned ranges and drops
 * any that can't be trusted. Stored on `clip_sections.supporting_moments`.
 */

export const SUPPORTING_ROLES = ["setup", "detail", "payoff"] as const;
export type SupportingRole = (typeof SUPPORTING_ROLES)[number];

export interface SupportingMoment {
  /** The verbatim line the picker quoted. */
  quote: string;
  role: SupportingRole;
  /** Why it belongs with this section, one short sentence (for the editor). */
  why: string;
  /** Cue-aligned range covering the quote. */
  startSec: number;
  endSec: number;
}

export interface SupportingQuoteInput {
  quote?: unknown;
  role?: unknown;
  why?: unknown;
}

export const MAX_SUPPORTING_MOMENTS = 3;
/** A stitched-in moment is a line or two (editors' average is ~13 s). */
export const MAX_SUPPORTING_SEC = 30;
const MIN_QUOTE_WORDS = 6;

/**
 * Resolve the picker's supporting quotes for one section. Keeps a quote only
 * when it is found verbatim in the transcript, sits OUTSIDE the section's own
 * window (a line already in the clip isn't something to stitch in), and its
 * cue-aligned range is short. De-duplicates overlapping ranges. Never throws:
 * a bad suggestion is dropped, never fails the section.
 */
export function locateSupportingMoments(args: {
  quotes: unknown;
  sectionStartSec: number;
  sectionEndSec: number;
  words: TranscriptWord[];
  segments: TranscriptSegment[];
}): SupportingMoment[] {
  if (!Array.isArray(args.quotes)) return [];
  const out: SupportingMoment[] = [];
  for (const raw of args.quotes as SupportingQuoteInput[]) {
    if (out.length >= MAX_SUPPORTING_MOMENTS) break;
    if (!raw || typeof raw !== "object") continue;
    const quote = typeof raw.quote === "string" ? raw.quote.trim() : "";
    if (quote.split(/\s+/).filter(Boolean).length < MIN_QUOTE_WORDS) continue;
    const role: SupportingRole = SUPPORTING_ROLES.includes(raw.role as SupportingRole)
      ? (raw.role as SupportingRole)
      : "detail";
    const why = typeof raw.why === "string" ? raw.why.trim().slice(0, 200) : "";

    const match = findAnchorInWords(quote, args.words);
    if (!match) continue;
    const range = snapToCues(match.startSec, match.endSec, args.segments);
    if (range.endSec - range.startSec > MAX_SUPPORTING_SEC) continue;
    // Inside (or overlapping) the section's own window → already in the clip.
    if (range.endSec > args.sectionStartSec && range.startSec < args.sectionEndSec) {
      continue;
    }
    if (out.some((m) => range.endSec > m.startSec && range.startSec < m.endSec)) {
      continue;
    }
    out.push({ quote, role, why, ...range });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Widen [start, end] to the transcript cues it touches, so a stitched-in
 *  moment never starts or ends mid-cue. Falls back to the word range. */
export function snapToCues(
  startSec: number,
  endSec: number,
  segments: TranscriptSegment[],
): { startSec: number; endSec: number } {
  let s = startSec;
  let e = endSec;
  for (const seg of segments) {
    if (seg.endSec <= startSec || seg.startSec >= endSec) continue;
    s = Math.min(s, seg.startSec);
    e = Math.max(e, seg.endSec);
  }
  return { startSec: round3(s), endSec: round3(e) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Section-picker version that started suggesting moments (section-v2). */
export const STITCH_SINCE_SECTION_VERSION = 2;

export interface StitchSectionState {
  promptVersion: number;
  supportingMoments: SupportingMoment[] | null;
  killedAt: Date | null;
}

/**
 * M3: true when a section predates section-v2 and has never been asked for
 * stitch lines, so the editor should have the worker find them. A v2
 * section's NULL means the picker found none — not pending — and the M3
 * task stores `[]` for none, so a section is asked at most once.
 */
export function needsStitchSuggest(s: StitchSectionState | null | undefined): boolean {
  if (!s) return false;
  return (
    s.killedAt == null &&
    s.supportingMoments == null &&
    s.promptVersion < STITCH_SINCE_SECTION_VERSION
  );
}
