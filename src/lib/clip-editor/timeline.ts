/**
 * Timeline math for the editor's Descript-style timeline. Pure — the
 * component (components/clip-editor/timeline.tsx) only draws what this says.
 *
 * The timeline is the clip AS IT PLAYS (output time, cuts closed up). Each
 * section of the doc is one PIECE on it — the unit the blade cuts, Select
 * picks and Delete removes (and, later, what a per-scene layout attaches to).
 * Removals inside a piece show as thin seams, not gaps.
 */
import type { RenderPlan } from "./plan";

export interface TimelinePiece {
  sectionId: string;
  /** 1-based, in play order. */
  index: number;
  outStartSec: number;
  outEndSec: number;
  /** Output times inside the piece where the footage jumps (removed words). */
  seams: number[];
}

export function timelinePieces(plan: RenderPlan): TimelinePiece[] {
  const pieces: TimelinePiece[] = [];
  for (const seg of plan.segments) {
    const last = pieces[pieces.length - 1];
    if (last && last.sectionId === seg.sectionId) {
      last.seams.push(seg.outStartSec);
      last.outEndSec = seg.outEndSec;
      continue;
    }
    pieces.push({ sectionId: seg.sectionId, index: pieces.length + 1, outStartSec: seg.outStartSec, outEndSec: seg.outEndSec, seams: [] });
  }
  return pieces;
}

/** The piece playing at output time `t` (the last one at the very end). */
export function pieceAt(pieces: TimelinePiece[], t: number): TimelinePiece | null {
  for (const p of pieces) if (t < p.outEndSec) return p;
  return pieces[pieces.length - 1] ?? null;
}

/** Piece edges, for ⏮ / ⏭: the nearest edge strictly before / after `t`. */
export function edgeBefore(pieces: TimelinePiece[], t: number): number {
  let best = 0;
  for (const p of pieces) for (const e of [p.outStartSec, ...p.seams]) if (e < t - 0.05 && e > best) best = e;
  return best;
}
export function edgeAfter(pieces: TimelinePiece[], t: number, durationSec: number): number {
  let best = durationSec;
  for (const p of pieces) for (const e of [p.outStartSec, ...p.seams, p.outEndSec]) if (e > t + 0.05 && e < best) best = e;
  return best;
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Seconds between labelled ruler ticks: the smallest step that leaves at
 *  least `minPx` between labels. */
export function rulerStep(pxPerSec: number, minPx = 72): number {
  for (const s of TICK_STEPS) if (s * pxPerSec >= minPx) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/** "0:05", "1:20", and "0:05.5" when the step is under a second. */
export function rulerLabel(sec: number, step: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const whole = step < 1 ? s.toFixed(1).padStart(4, "0") : String(Math.round(s)).padStart(2, "0");
  return `${m}:${whole}`;
}

/** Zoom is a multiple of "fit the whole clip in view" (100%). */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 40;
export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}
