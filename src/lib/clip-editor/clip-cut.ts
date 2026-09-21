/**
 * What a clip actually says — the transcript text that survives the edit,
 * as a plain string for prompts (the post drafter, the editor's Post tab).
 *
 * Words are punctuated at the source (see transcripts/punctuate-words.ts),
 * so joining the kept words reads as prose. Trims (a shaved word edge) keep
 * the word; every other removal drops it. Sections come out in play order
 * (an intro pulled from later in the video reads first, as it plays), one
 * paragraph each, so a stitched clip reads as its beats. Pure.
 */
import type { ClipEditDoc } from "./doc";
import { buildTranscriptView } from "./transcript-view";
import type { EditorWord } from "./words";

export interface ClipCut {
  /** Seconds into the source where the clip starts / ends. */
  startSec: number;
  endSec: number;
  /** Seconds of video after cuts. */
  durationSec: number;
  transcript: string;
}

/** The cut described by an edit document. */
export function clipCutFromDoc(doc: ClipEditDoc, words: EditorWord[]): ClipCut | null {
  const sections = doc.sections;
  if (sections.length === 0) return null;
  const view = buildTranscriptView(doc, words);
  const paragraphs: string[] = [];
  for (const section of sections) {
    const kept = view.words.filter((w) => w.sectionId === section.id && w.state === "kept");
    if (kept.length > 0) paragraphs.push(kept.map((w) => w.text).join(" "));
  }
  const durationSec = sections.reduce(
    (sum, s) => sum + (s.endSec - s.startSec) - s.removals.reduce((r, x) => r + (x.endSec - x.startSec), 0),
    0,
  );
  return {
    startSec: Math.min(...sections.map((s) => s.startSec)),
    endSec: Math.max(...sections.map((s) => s.endSec)),
    durationSec: Math.max(0, durationSec),
    transcript: paragraphs.join("\n\n"),
  };
}

/** The cut an idea proposes before anyone has edited it: every word whose
 *  middle falls inside [startSec, endSec]. */
export function clipCutFromRange(range: { startSec: number; endSec: number }, words: EditorWord[]): ClipCut {
  const inside = words.filter((w) => {
    const mid = (w.startSec + w.endSec) / 2;
    return mid >= range.startSec && mid < range.endSec;
  });
  return {
    startSec: range.startSec,
    endSec: range.endSec,
    durationSec: Math.max(0, range.endSec - range.startSec),
    transcript: inside.map((w) => w.text).join(" "),
  };
}
