/**
 * Trimming a video slide's clip against the transcript: the words around
 * the clip, snapping an edge to a sentence boundary, and turning a word
 * pick into a range. Pure; the trimmer UI (clip-trimmer.tsx) calls these.
 */
import type { EditorWord } from "@/lib/clip-editor/words";

const SENTENCE_END = /[.!?…]["')\]]?$/;
/** A sentence snap never moves an edge further than this — transcripts
 *  without punctuation would otherwise run to the end of the video. */
const MAX_SNAP_SEC = 12;

/** Does word i begin a sentence? Punctuation on the previous word, a long
 *  pause, or — for transcripts without punctuation — a capital after a
 *  lowercase word ("...was simple The first prototype..."). */
function isSentenceStart(words: EditorWord[], i: number): boolean {
  if (i <= 0) return true;
  const prev = words[i - 1];
  const cur = words[i];
  if (SENTENCE_END.test(prev.text)) return true;
  if (cur.startSec - prev.endSec >= 1.2) return true;
  return /^[A-Z]/.test(cur.text) && /^[a-z]/.test(prev.text) && !/^(I|I'm|I've|I'll|I'd)$/.test(cur.text);
}
/** Air before the first word / after the last so speech never starts or
 *  ends on a hard cut. */
export const LEAD_IN_SEC = 0.15;
export const TAIL_SEC = 0.25;

export interface ClipRange {
  startSec: number;
  endSec: number;
}

/** Words shown in the trimmer: the clip plus `padSec` either side. */
export function wordsAround(words: EditorWord[], range: ClipRange, padSec = 25): EditorWord[] {
  return words.filter((w) => w.endSec >= range.startSec - padSec && w.startSec <= range.endSec + padSec);
}

export function isWordInClip(w: EditorWord, range: ClipRange): boolean {
  const mid = (w.startSec + w.endSec) / 2;
  return mid >= range.startSec && mid < range.endSec;
}

/** Start the clip at this word. Keeps the end unless it's now before the start. */
export function startAtWord(words: EditorWord[], index: number, range: ClipRange): ClipRange {
  const w = words[index];
  if (!w) return range;
  const startSec = round2(Math.max(0, w.startSec - LEAD_IN_SEC));
  const endSec = range.endSec > startSec + 1 ? range.endSec : round2(Math.min(startSec + 30, words[words.length - 1].endSec + TAIL_SEC));
  return { startSec, endSec };
}

/** End the clip after this word. Keeps the start unless it's now after the end. */
export function endAtWord(words: EditorWord[], index: number, range: ClipRange): ClipRange {
  const w = words[index];
  if (!w) return range;
  const endSec = round2(w.endSec + TAIL_SEC);
  const startSec = range.startSec < endSec - 1 ? range.startSec : round2(Math.max(0, endSec - 30));
  return { startSec, endSec };
}

/** Move the start back to the beginning of the sentence it's in. */
export function snapStartToSentence(words: EditorWord[], range: ClipRange): ClipRange {
  let i = words.findIndex((w) => isWordInClip(w, range));
  if (i < 0) return range;
  const limit = range.startSec - MAX_SNAP_SEC;
  while (i > 0 && !isSentenceStart(words, i) && words[i - 1].startSec >= limit) i--;
  return startAtWord(words, i, range);
}

/** Move the end forward to the end of the sentence it's in. */
export function snapEndToSentence(words: EditorWord[], range: ClipRange): ClipRange {
  let i = -1;
  for (let k = 0; k < words.length; k++) if (isWordInClip(words[k], range)) i = k;
  if (i < 0) return range;
  const limit = range.endSec + MAX_SNAP_SEC;
  while (i < words.length - 1 && !isSentenceStart(words, i + 1) && words[i + 1].endSec <= limit) i++;
  return endAtWord(words, i, range);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
