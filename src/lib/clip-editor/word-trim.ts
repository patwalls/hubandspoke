/**
 * Fine-trimming one word — the audio right around it, and where it is cut.
 *
 * The problem this solves: Whisper's word times are the WORD, not the sound.
 * "that." ends at 429.58 but the breath, the lip smack or the onset of the
 * next line runs on until the next word starts at 430.10 — and when that
 * next line is cut, the half second in between still plays. Shaving the
 * word's own edge (◁ start / end ▷) never reaches it.
 *
 * So a word's trim window is the stretch of source audio that belongs to it
 * on either side: from the previous word's end (or up to a second before
 * the word) to the next word's start (or up to a second after). Inside it,
 * IN and OUT are the cut points: everything between them plays, everything
 * outside them within the window is cut (as `trim` removals, which keep the
 * word in the transcript). Dragging OUT left of the word's end trims the
 * tail; dragging it right into the gap keeps more. Pure.
 */
import type { Section, TimeRange } from "./doc";
import { addRemoval, restoreRange } from "./removals";
import type { EditorWord } from "./words";

/** How far past a word the window may reach when the neighbour is far. */
const REACH_SEC = 1.0;
/** The least of a word that must remain. */
const MIN_KEEP_SEC = 0.06;
/** A press of ◁ / ▷ moves a cut point this much once it is on the word. */
export const TRIM_STEP_SEC = 0.08;

export interface WordTrimWindow {
  sectionId: string;
  /** The window's edges in source seconds. */
  minSec: number;
  maxSec: number;
  /** The word itself. */
  wordStartSec: number;
  wordEndSec: number;
  /** Where the audio is cut today (== min/max when nothing is cut). */
  inSec: number;
  outSec: number;
  /** Words inside the window, for drawing (the trimmed word included). */
  neighbours: Array<{ text: string; startSec: number; endSec: number; self: boolean }>;
}

export function wordTrimWindow(section: Section, words: EditorWord[], index: number, texts?: (i: number) => string): WordTrimWindow | null {
  const word = words[index];
  if (!word) return null;
  const prev = words[index - 1];
  const next = words[index + 1];
  const minSec = round3(Math.max(section.startSec, prev ? Math.max(prev.endSec, word.startSec - REACH_SEC) : word.startSec - REACH_SEC));
  const maxSec = round3(Math.min(section.endSec, next ? Math.min(next.startSec, word.endSec + REACH_SEC) : word.endSec + REACH_SEC));
  if (maxSec - minSec < MIN_KEEP_SEC) return null;
  // The cuts are the removals touching the window's edges (a trim always
  // runs to an edge — see applyWordTrim). Anything else inside the window
  // is a stray sliver and gets normalised away on the next apply.
  let inSec = minSec;
  let outSec = maxSec;
  for (const r of section.removals) {
    if (r.startSec <= minSec + 1e-3 && r.endSec > minSec && r.endSec < maxSec) inSec = Math.max(inSec, r.endSec);
    if (r.endSec >= maxSec - 1e-3 && r.startSec < maxSec && r.startSec > minSec) outSec = Math.min(outSec, r.startSec);
  }
  ({ inSec, outSec } = clampWordTrim({ minSec, maxSec, wordStartSec: word.startSec, wordEndSec: word.endSec } as WordTrimWindow, inSec, outSec));
  const neighbours: WordTrimWindow["neighbours"] = [];
  for (let i = Math.max(0, index - 3); i < Math.min(words.length, index + 4); i++) {
    const w = words[i];
    if (w.endSec <= minSec - REACH_SEC || w.startSec >= maxSec + REACH_SEC) continue;
    neighbours.push({ text: texts ? texts(i) : w.text, startSec: w.startSec, endSec: w.endSec, self: i === index });
  }
  return { sectionId: section.id, minSec, maxSec, wordStartSec: word.startSec, wordEndSec: word.endSec, inSec: round3(inSec), outSec: round3(outSec), neighbours };
}

/** Clamp a proposed pair of cut points to the window. The word's middle
 *  always plays — a trim never turns the word into a cut one (that is what
 *  Remove is for), so the transcript keeps showing it as kept. */
export function clampWordTrim(win: WordTrimWindow, inSec: number, outSec: number): { inSec: number; outSec: number } {
  const mid = (win.wordStartSec + win.wordEndSec) / 2;
  const i = Math.min(Math.max(win.minSec, inSec), mid - MIN_KEEP_SEC / 2);
  const o = Math.max(Math.min(win.maxSec, outSec), mid + MIN_KEEP_SEC / 2);
  return { inSec: round3(i), outSec: round3(o) };
}

/** Rewrite the cuts inside the window so exactly [inSec, outSec] plays. */
export function applyWordTrim(section: Section, win: WordTrimWindow, inSec: number, outSec: number): Section {
  const c = clampWordTrim(win, inSec, outSec);
  let next = restoreRange(section, { startSec: win.minSec, endSec: win.maxSec });
  if (c.inSec > win.minSec + 1e-3) next = addRemoval(next, { startSec: win.minSec, endSec: c.inSec }, "trim");
  if (c.outSec < win.maxSec - 1e-3) next = addRemoval(next, { startSec: c.outSec, endSec: win.maxSec }, "trim");
  return next;
}

/**
 * One press of ◁ start / end ▷: the first press cuts the gap beside the
 * word (the usual culprit), later presses shave the word itself, a step at
 * a time, never past its middle. Null when there is nothing left to shave.
 */
export function stepWordTrim(win: WordTrimWindow, edge: "start" | "end"): { inSec: number; outSec: number } | null {
  if (edge === "start") {
    const target = win.inSec < win.wordStartSec - 1e-3 ? win.wordStartSec : win.inSec + TRIM_STEP_SEC;
    const c = clampWordTrim(win, target, win.outSec);
    return c.inSec > win.inSec + 0.005 ? c : null;
  }
  const target = win.outSec > win.wordEndSec + 1e-3 ? win.wordEndSec : win.outSec - TRIM_STEP_SEC;
  const c = clampWordTrim(win, win.inSec, target);
  return c.outSec < win.outSec - 0.005 ? c : null;
}

/** The source range worth hearing after a trim: a beat before IN, through
 *  the join after OUT. */
export function wordTrimAudition(win: WordTrimWindow, inSec: number, outSec: number): TimeRange {
  return { startSec: Math.max(0, inSec - 0.7), endSec: outSec + 0.5 };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
