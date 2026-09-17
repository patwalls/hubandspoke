/**
 * Transcript words as the editor sees them, plus the word⇄time-range mapping
 * that turns "delete these words" into a removal on the source timeline.
 */
import type { TimeRange } from "./doc";

export interface EditorWord {
  /** Index into the FULL transcript `words` array — stable for the lifetime
   *  of a transcript row, used as the React key and for LLM round-trips.
   *  Never persisted in the doc (the doc stores time ranges). */
  index: number;
  text: string;
  startSec: number;
  endSec: number;
}

interface TranscriptWord {
  word: string;
  startSec: number;
  endSec: number;
}

interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * Word-level timings for a transcript. Whisper rows carry real ones. Caption
 * -scrape rows (YouTube auto-captions etc.) only have segments, so we spread
 * each segment's words across its span proportionally to word length —
 * coarse, but it keeps the editor usable on any transcribed source. The
 * `synthetic` flag lets the UI warn that cuts will be approximate.
 */
export function resolveTranscriptWords(transcript: {
  words: TranscriptWord[] | null | undefined;
  segments: TranscriptSegment[];
}): { words: EditorWord[]; synthetic: boolean } {
  if (transcript.words && transcript.words.length > 0) {
    return {
      synthetic: false,
      words: transcript.words
        .map((w, index) => ({
          index,
          text: w.word.trim(),
          startSec: w.startSec,
          endSec: Math.max(w.endSec, w.startSec),
        }))
        .filter((w) => w.text.length > 0),
    };
  }

  const words: EditorWord[] = [];
  let index = 0;
  for (const seg of transcript.segments) {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const span = Math.max(0, seg.endSec - seg.startSec);
    const totalChars = tokens.reduce((n, t) => n + t.length, 0);
    let cursor = seg.startSec;
    for (const token of tokens) {
      const dur = totalChars > 0 ? (span * token.length) / totalChars : 0;
      words.push({
        index: index++,
        text: token,
        startSec: cursor,
        endSec: cursor + dur,
      });
      cursor += dur;
    }
  }
  return { words, synthetic: true };
}

/** Words whose midpoint falls inside any of the given windows. */
export function wordsInWindows(
  words: EditorWord[],
  windows: TimeRange[],
): EditorWord[] {
  return words.filter((w) => {
    const mid = (w.startSec + w.endSec) / 2;
    return windows.some((r) => mid >= r.startSec && mid < r.endSec);
  });
}

/** A word belongs to a range when its midpoint does — so a range boundary
 *  that lands mid-word assigns the word to exactly one side. */
export function isWordInRange(word: EditorWord, range: TimeRange): boolean {
  const mid = (word.startSec + word.endSec) / 2;
  return mid >= range.startSec && mid < range.endSec;
}

/** If the pause after a deleted run is shorter than this, swallow it too —
 *  otherwise every deleted word leaves a sliver of dead air behind. */
const SWALLOW_GAP_SEC = 0.15;

/**
 * The source range that deleting a contiguous run of words should remove.
 * `words` is the full ordered word list the run came from; `first`/`last`
 * are positions in that list.
 *
 * Starts at the first word's start (so the previous word's tail is intact)
 * and runs to the next word's start when that's close, else just the run's
 * own end — a long pause after a deleted word is a separate decision
 * ("remove silences"), not a side effect of deleting the word.
 */
export function rangeForWordRun(
  words: EditorWord[],
  first: number,
  last: number,
): TimeRange | null {
  const a = words[first];
  const b = words[last];
  if (!a || !b || last < first) return null;
  const next = words[last + 1];
  const endSec =
    next && next.startSec - b.endSec <= SWALLOW_GAP_SEC
      ? Math.max(b.endSec, next.startSec)
      : b.endSec;
  if (endSec <= a.startSec) return null;
  return { startSec: a.startSec, endSec };
}

/**
 * Pauses worth removing: gaps between consecutive words longer than
 * `minGapSec`, shrunk by `keepSec` on each side so speech keeps a natural
 * breath around the cut instead of slamming word into word.
 */
export function findSilences(
  words: EditorWord[],
  window: TimeRange,
  opts: { minGapSec?: number; keepSec?: number } = {},
): TimeRange[] {
  const minGapSec = opts.minGapSec ?? 0.6;
  const keepSec = opts.keepSec ?? 0.15;
  const inWindow = words.filter((w) => isWordInRange(w, window));
  const out: TimeRange[] = [];
  for (let i = 0; i < inWindow.length - 1; i++) {
    const gapStart = inWindow[i].endSec;
    const gapEnd = inWindow[i + 1].startSec;
    if (gapEnd - gapStart < minGapSec) continue;
    const range = { startSec: gapStart + keepSec, endSec: gapEnd - keepSec };
    if (range.endSec - range.startSec > 0.05) out.push(range);
  }
  return out;
}
