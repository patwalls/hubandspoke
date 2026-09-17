/**
 * The transcript as the editor displays it: every word tagged with whether
 * it plays, was removed (and why), or sits outside the clip — plus the pauses
 * between words, which are editable too.
 *
 * Pure derivation from (doc, words). The transcript UI renders this and turns
 * selections back into time ranges with `selectionActions`; it never reasons
 * about removals itself.
 */
import type { ClipEditDoc, RemovalReason, Section, TimeRange } from "./doc";
import { wordEditKey } from "./doc";
import { removalAt } from "./removals";
import { isWordInRange, rangeForWordRun, type EditorWord } from "./words";

/** Pauses at least this long get their own chip in the transcript. */
export const GAP_CHIP_MIN_SEC = 0.6;
/** Speech kept on each side when a pause is removed. */
const GAP_KEEP_SEC = 0.15;

export type WordState = "kept" | "removed" | "outside";

export interface ViewWord {
  kind: "word";
  /** Position in `TranscriptView.words` — what selections are made of. */
  pos: number;
  word: EditorWord;
  /** Caption text: the correction if there is one, else the transcript. */
  text: string;
  corrected: boolean;
  sectionId: string;
  state: WordState;
  reason: RemovalReason | null;
}

export interface ViewGap {
  kind: "gap";
  key: string;
  sectionId: string;
  /** The removable part of the pause (already shrunk by GAP_KEEP_SEC). */
  range: TimeRange;
  durationSec: number;
  removed: boolean;
}

export interface ViewSection {
  section: Section;
  tokens: Array<ViewWord | ViewGap>;
}

export interface TranscriptView {
  sections: ViewSection[];
  /** Every word of every section, in display order. */
  words: ViewWord[];
}

export function buildTranscriptView(
  doc: ClipEditDoc,
  words: EditorWord[],
  /** Source window shown around body sections so the clip can be extended. */
  context: TimeRange,
): TranscriptView {
  const flat: ViewWord[] = [];
  const sections = doc.sections.map((section): ViewSection => {
    const window: TimeRange =
      section.role === "body"
        ? {
            startSec: Math.min(context.startSec, section.startSec),
            endSec: Math.max(context.endSec, section.endSec),
          }
        : section;
    const tokens: Array<ViewWord | ViewGap> = [];
    const sectionWords = words.filter((w) => isWordInRange(w, window));

    sectionWords.forEach((word, i) => {
      const inside = isWordInRange(word, section);
      const removal = inside
        ? removalAt(section, (word.startSec + word.endSec) / 2)
        : null;
      const correction = doc.wordEdits[wordEditKey(word.startSec)];
      const view: ViewWord = {
        kind: "word",
        pos: flat.length,
        word,
        text: correction ?? word.text,
        corrected: correction != null,
        sectionId: section.id,
        state: !inside ? "outside" : removal ? "removed" : "kept",
        reason: removal?.reason ?? null,
      };
      flat.push(view);
      tokens.push(view);

      const next = sectionWords[i + 1];
      if (!next) return;
      const gap = next.startSec - word.endSec;
      if (gap < GAP_CHIP_MIN_SEC) return;
      const range = {
        startSec: word.endSec + GAP_KEEP_SEC,
        endSec: next.startSec - GAP_KEEP_SEC,
      };
      // Only pauses fully inside the clip are editable.
      if (range.startSec < section.startSec || range.endSec > section.endSec) return;
      tokens.push({
        kind: "gap",
        key: `${section.id}:${Math.round(word.endSec * 1000)}`,
        sectionId: section.id,
        range,
        durationSec: gap,
        removed: removalAt(section, (range.startSec + range.endSec) / 2) != null,
      });
    });
    return { section, tokens };
  });
  return { sections, words: flat };
}

export interface SelectionActions {
  /** Per-section source ranges the selected in-clip words cover. */
  ranges: Array<{ sectionId: string; range: TimeRange }>;
  /** True when every selected in-clip word is already removed. */
  allRemoved: boolean;
  /** Selected words outside the clip → the window that would include them. */
  extend: { sectionId: string; window: TimeRange } | null;
  /** Trim the clip to start / end at the selection. Null when N/A. */
  startHere: { sectionId: string; window: TimeRange } | null;
  endHere: { sectionId: string; window: TimeRange } | null;
  wordCount: number;
}

/** What can be done with the words at positions [lo, hi]. */
export function selectionActions(
  view: TranscriptView,
  lo: number,
  hi: number,
): SelectionActions {
  const selected = view.words.slice(lo, hi + 1);
  const ranges: SelectionActions["ranges"] = [];
  let allRemoved = selected.some((w) => w.state !== "outside");
  let extend: SelectionActions["extend"] = null;

  for (const vs of view.sections) {
    const sectionWords = vs.tokens.filter((t): t is ViewWord => t.kind === "word");
    const picked = sectionWords.filter((w) => w.pos >= lo && w.pos <= hi);
    if (picked.length === 0) continue;

    const inside = picked.filter((w) => w.state !== "outside");
    if (inside.length > 0) {
      if (inside.some((w) => w.state === "kept")) allRemoved = false;
      const first = sectionWords.indexOf(inside[0]);
      const last = sectionWords.indexOf(inside[inside.length - 1]);
      const range = rangeForWordRun(
        sectionWords.map((w) => w.word),
        first,
        last,
      );
      if (range) ranges.push({ sectionId: vs.section.id, range });
    }

    const outside = picked.filter((w) => w.state === "outside");
    if (outside.length > 0 && !extend) {
      extend = {
        sectionId: vs.section.id,
        window: {
          startSec: Math.min(vs.section.startSec, outside[0].word.startSec),
          endSec: Math.max(
            vs.section.endSec,
            outside[outside.length - 1].word.endSec,
          ),
        },
      };
    }
  }

  const first = selected.find((w) => w.state !== "outside");
  const last = [...selected].reverse().find((w) => w.state !== "outside");
  const sectionOf = (id: string) => view.sections.find((s) => s.section.id === id)!.section;
  const startHere =
    first && first.word.startSec > sectionOf(first.sectionId).startSec + 0.01
      ? {
          sectionId: first.sectionId,
          window: {
            startSec: first.word.startSec,
            endSec: sectionOf(first.sectionId).endSec,
          },
        }
      : null;
  const endHere =
    last && last.word.endSec < sectionOf(last.sectionId).endSec - 0.01
      ? {
          sectionId: last.sectionId,
          window: {
            startSec: sectionOf(last.sectionId).startSec,
            endSec: last.word.endSec,
          },
        }
      : null;

  return { ranges, allRemoved, extend, startHere, endHere, wordCount: selected.length };
}
