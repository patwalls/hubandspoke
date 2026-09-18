/**
 * Rolling captions for a video slide: the transcript words inside the
 * clip, grouped into cues, laid out in the captions element's box with the
 * same engine as text. Pure — the stage picks the active cue by the
 * <video>'s time, the exporter writes every cue into an ASS script.
 */
import type { EditorWord } from "@/lib/clip-editor/words";
import type { DesignCaptionsElement, DesignTextElement } from "./doc";
import { layoutDesignText, type DesignTextLayout } from "./layout";

export interface DesignCaptionCue {
  /** Seconds from the START of the clip (not the source). */
  startSec: number;
  endSec: number;
  text: string;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;
const CLAUSE_END = /[,;:]["')\]]?$/;
/** A gap this long between words starts a new cue even mid-sentence. */
const GAP_BREAK_SEC = 1.2;

/**
 * Cues in CLIP time. A cue ends at a sentence end, at a long pause, or when
 * it reaches `maxWords`; a clause end (comma) is preferred as the split when
 * a cue is already at least half full. Each cue shows until the next begins
 * so the box is never blank mid-sentence, but a pause > GAP_BREAK_SEC ends
 * it at the last word instead.
 */
export function buildDesignCaptionCues(
  words: EditorWord[],
  clip: { startSec: number; endSec: number },
  maxWords: number,
): DesignCaptionCue[] {
  const inClip = words.filter((w) => {
    const mid = (w.startSec + w.endSec) / 2;
    return mid >= clip.startSec && mid < clip.endSec;
  });
  const cues: DesignCaptionCue[] = [];
  let cur: EditorWord[] = [];
  const flush = (next: EditorWord | undefined) => {
    if (cur.length === 0) return;
    const first = cur[0];
    const last = cur[cur.length - 1];
    const gapToNext = next ? next.startSec - last.endSec : Infinity;
    const end = next && gapToNext <= GAP_BREAK_SEC ? next.startSec : last.endSec;
    cues.push({
      startSec: Math.max(0, first.startSec - clip.startSec),
      endSec: Math.min(clip.endSec, end) - clip.startSec,
      text: cur.map((w) => w.text).join(" "),
    });
    cur = [];
  };
  for (let i = 0; i < inClip.length; i++) {
    const w = inClip[i];
    const next = inClip[i + 1];
    cur.push(w);
    const full = cur.length >= maxWords;
    const sentence = SENTENCE_END.test(w.text);
    const clause = CLAUSE_END.test(w.text) && cur.length >= Math.ceil(maxWords / 2);
    const pause = next ? next.startSec - w.endSec > GAP_BREAK_SEC : false;
    if (full || sentence || clause || pause || !next) flush(next);
  }
  // First cue starts at 0 so the box isn't empty while the speaker inhales.
  if (cues.length > 0 && cues[0].startSec < 0.6) cues[0].startSec = 0;
  return cues.filter((c) => c.endSec > c.startSec);
}

export function activeCue(cues: DesignCaptionCue[], clipTimeSec: number): DesignCaptionCue | null {
  for (const c of cues) if (clipTimeSec >= c.startSec && clipTimeSec < c.endSec) return c;
  return null;
}

/** Lay one cue out in the captions box — a text element in disguise. */
export function layoutCaptionCue(el: DesignCaptionsElement, text: string): DesignTextLayout {
  const asText: DesignTextElement = {
    id: el.id, name: el.name, type: "text", x: el.x, y: el.y, w: el.w, h: el.h, opacity: el.opacity, locked: el.locked,
    spans: [{ text }],
    style: el.style,
  };
  return layoutDesignText(asText);
}
