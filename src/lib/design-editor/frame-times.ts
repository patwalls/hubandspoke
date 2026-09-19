/**
 * Where to grab candidate cover frames from a source video. Pure.
 *
 * Even spacing finds title cards and screen shares as often as faces. When
 * the transcript knows who is talking, sample the GUEST's stretches of
 * speech (the founder — the person the post is about) instead: the camera
 * is on them, and a long stretch is a settled shot, not a cutaway.
 */
import type { EditorWord } from "@/lib/clip-editor/words";

export interface SpeakerLike {
  id: string;
  role: string;
}

export interface FrameTimesArgs {
  durationSec: number;
  count: number;
  words?: EditorWord[];
  speakers?: SpeakerLike[];
}

/** Stretches (≥ minSec) where one of `speakerIds` talks continuously. */
export function speakingStretches(words: EditorWord[], speakerIds: Set<string>, minSec = 8): Array<{ startSec: number; endSec: number }> {
  const out: Array<{ startSec: number; endSec: number }> = [];
  let cur: { startSec: number; endSec: number } | null = null;
  for (const w of words) {
    const mine = !!w.speakerId && speakerIds.has(w.speakerId);
    if (mine && cur && w.startSec - cur.endSec < 2) cur.endSec = w.endSec;
    else {
      if (cur && cur.endSec - cur.startSec >= minSec) out.push(cur);
      cur = mine ? { startSec: w.startSec, endSec: w.endSec } : null;
    }
  }
  if (cur && cur.endSec - cur.startSec >= minSec) out.push(cur);
  return out;
}

export function frameTimes(args: FrameTimesArgs): number[] {
  const { durationSec, count } = args;
  const even = () => Array.from({ length: count }, (_, i) => round2(durationSec * (0.04 + (0.92 * i) / Math.max(1, count - 1))));
  const guests = new Set((args.speakers ?? []).filter((s) => s.role === "guest").map((s) => s.id));
  if (!args.words?.length || guests.size === 0) return even();
  const stretches = speakingStretches(args.words, guests);
  const total = stretches.reduce((n, s) => n + (s.endSec - s.startSec), 0);
  if (stretches.length === 0 || total < 60) return even();
  // Walk the stretches as one timeline and drop `count` evenly spaced marks
  // on it, a little inside each stretch's edges (the cut to the guest is
  // often a beat late).
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    let target = (total * (i + 0.5)) / count;
    for (const s of stretches) {
      const len = s.endSec - s.startSec;
      if (target <= len) {
        const inset = Math.min(1.5, len * 0.1);
        times.push(round2(Math.min(s.endSec - inset, Math.max(s.startSec + inset, s.startSec + target))));
        break;
      }
      target -= len;
    }
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
