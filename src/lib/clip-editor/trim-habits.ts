/**
 * How editors trim a format's AI clip windows (project "clip trim", M1).
 *
 * Every clip edit starts as the clip idea's [startSec, endSec] window. On
 * every brand and format, editors cut the opening run-up on ~40–50% of
 * edited clips (median 7 s, 30 s on tutorial brands) and the wind-down on
 * about as many. They do it by hand, as a removal at the start or end of the
 * scene, before the clip goes out. The clip-idea writer can already narrow a
 * window (tightStartSec / tightEndSec), so it gets this format's numbers and
 * is told to start where editors start and end where they end.
 *
 * Pure: the loader is `services/clip-editor/trim-habits.ts`. Only source
 * scenes count (an uploaded intro is not the AI window); the scene that
 * overlaps the idea's window most is "the clip". Its kept start = its start
 * moved past any removals that begin at the start; kept end likewise.
 */
import type { ClipEditDoc, Section } from "./doc";

export interface ClipTrim {
  /** Seconds cut off the AI window's start (0 = started where the AI did, or earlier). */
  headSec: number;
  /** Seconds cut off the AI window's end. */
  tailSec: number;
}

export interface TrimSummary {
  clips: number;
  headCut: number;
  medianHeadSec: number;
  tailCut: number;
  medianTailSec: number;
}

/** A cut shorter than this is an edge tidy, not a trim. */
export const MIN_TRIM_SEC = 3;
/** Fewer edited clips than this says nothing about a format. */
export const MIN_TRIM_CLIPS = 5;
/** Below this share of clips trimmed at an end, that end is left alone. */
export const MIN_TRIM_SHARE = 0.25;
/** A removal that starts within this of the kept edge is "at the edge". */
const EDGE_SLACK_SEC = 0.5;

const overlap = (s: Section, a: number, b: number) => Math.max(0, Math.min(s.endSec, b) - Math.max(s.startSec, a));

function keptRange(s: Section): { start: number; end: number } {
  const rm = [...s.removals].sort((x, y) => x.startSec - y.startSec);
  let start = s.startSec;
  for (const r of rm) {
    if (r.startSec > start + EDGE_SLACK_SEC) break;
    start = Math.max(start, r.endSec);
  }
  let end = s.endSec;
  for (const r of [...rm].reverse()) {
    if (r.endSec < end - EDGE_SLACK_SEC) break;
    end = Math.min(end, r.startSec);
  }
  return { start, end: Math.max(start, end) };
}

/** What the editor cut off this clip's AI window, or null when the doc has no
 *  source scene over the window (a clip rebuilt from other footage). */
export function clipTrim(idea: { startSec: number; endSec: number }, doc: ClipEditDoc): ClipTrim | null {
  const scenes = doc.sections.filter((s) => !s.mediaId && overlap(s, idea.startSec, idea.endSec) > 0);
  if (scenes.length === 0) return null;
  const main = scenes.reduce((a, b) => (overlap(b, idea.startSec, idea.endSec) > overlap(a, idea.startSec, idea.endSec) ? b : a));
  const kept = keptRange(main);
  const round = (n: number) => Math.round(Math.max(0, n) * 10) / 10;
  return { headSec: round(kept.start - idea.startSec), tailSec: round(idea.endSec - kept.end) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The format's trim habit over its recent edited clips, or null when there
 *  are too few clips or editors rarely trim either end. */
export function summarizeTrims(rows: Array<{ startSec: number; endSec: number; doc: ClipEditDoc }>): TrimSummary | null {
  const trims = rows.flatMap((r) => {
    const t = clipTrim(r, r.doc);
    return t ? [t] : [];
  });
  if (trims.length < MIN_TRIM_CLIPS) return null;
  const heads = trims.filter((t) => t.headSec >= MIN_TRIM_SEC).map((t) => t.headSec);
  const tails = trims.filter((t) => t.tailSec >= MIN_TRIM_SEC).map((t) => t.tailSec);
  if (heads.length / trims.length < MIN_TRIM_SHARE && tails.length / trims.length < MIN_TRIM_SHARE) return null;
  return {
    clips: trims.length,
    headCut: heads.length,
    medianHeadSec: heads.length ? Math.round(median(heads)) : 0,
    tailCut: tails.length,
    medianTailSec: tails.length ? Math.round(median(tails)) : 0,
  };
}

/** The clip writer's system-prompt block, or null with no habit to learn. */
export function trimHabitsBlock(s: TrimSummary | null): string | null {
  if (!s) return null;
  const share = (n: number) => n / s.clips >= MIN_TRIM_SHARE;
  const facts: string[] = [];
  const moves: string[] = [];
  if (share(s.headCut)) {
    facts.push(`cut the opening on ${s.headCut} (median ${s.medianHeadSec}s)`);
    moves.push(`start on the line where the point begins, not the run-up to it (set tightStartSec up to ~${s.medianHeadSec}s later when the section opens with setup, a question or a restart)`);
  }
  if (share(s.tailCut)) {
    facts.push(`cut the ending on ${s.tailCut} (median ${s.medianTailSec}s)`);
    moves.push(`end on the payoff line, not the wind-down after it (set tightEndSec up to ~${s.medianTailSec}s earlier when the section trails off)`);
  }
  return [
    `HOW EDITORS TRIM THIS FORMAT'S CLIPS — of the last ${s.clips} edited clips, editors ${facts.join(" and ")} before posting.`,
    ``,
    `Cut it the way they do: ${moves.join("; ")}. Only narrow where this section actually has that slack — a section that already starts on its point keeps its start. The anchor stays inside, and the clip stays at least 25s.`,
  ].join("\n");
}
