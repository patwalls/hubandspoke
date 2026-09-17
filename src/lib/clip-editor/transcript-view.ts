/**
 * The transcript as the editor displays it: EVERY word of the source, each
 * tagged with whether it plays, was removed (and why), or sits outside the
 * clip — plus the pauses between kept words, which are editable too.
 *
 * Pure derivation from (doc, words). The transcript UI renders this and turns
 * selections back into edits with `selectionActions`; it never reasons about
 * sections or removals itself.
 */
import type { ClipEditDoc, RemovalReason, Section, TimeRange } from "./doc";
import { wordEditKey } from "./doc";
import { removalAt } from "./removals";
import { rangeForWordRun, type EditorWord } from "./words";

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
  /** The section this word belongs to; null when outside the clip. */
  sectionId: string | null;
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

/** Marks where a section of the clip begins, inline in the transcript. */
export interface ViewMarker {
  kind: "marker";
  key: string;
  sectionId: string;
  /** 1-based play order. */
  index: number;
  startSec: number;
  endSec: number;
}

export type ViewToken = ViewWord | ViewGap | ViewMarker;

export interface TranscriptView {
  tokens: ViewToken[];
  /** Every word of the source, in order. */
  words: ViewWord[];
}

export function buildTranscriptView(
  doc: ClipEditDoc,
  words: EditorWord[],
): TranscriptView {
  const sections = [...doc.sections].sort((a, b) => a.startSec - b.startSec);
  const tokens: ViewToken[] = [];
  const flat: ViewWord[] = [];
  const marked = new Set<string>();
  let si = 0;

  const sectionFor = (mid: number): Section | null => {
    while (si < sections.length && mid >= sections[si].endSec) si++;
    const s = sections[si];
    return s && mid >= s.startSec ? s : null;
  };

  words.forEach((word, i) => {
    const mid = (word.startSec + word.endSec) / 2;
    const section = sectionFor(mid);
    const removal = section ? removalAt(section, mid) : null;
    const correction = doc.wordEdits[wordEditKey(word.startSec)];

    if (section && !marked.has(section.id)) {
      marked.add(section.id);
      tokens.push({
        kind: "marker",
        key: `m:${section.id}`,
        sectionId: section.id,
        index: sections.indexOf(section) + 1,
        startSec: section.startSec,
        endSec: section.endSec,
      });
    }

    const view: ViewWord = {
      kind: "word",
      pos: flat.length,
      word,
      text: correction ?? word.text,
      corrected: correction != null,
      sectionId: section?.id ?? null,
      state: !section ? "outside" : removal ? "removed" : "kept",
      reason: removal?.reason ?? null,
    };
    flat.push(view);
    tokens.push(view);

    // A pause chip, only for pauses wholly inside one section.
    const next = words[i + 1];
    if (!section || !next) return;
    const gap = next.startSec - word.endSec;
    if (gap < GAP_CHIP_MIN_SEC) return;
    const range = {
      startSec: word.endSec + GAP_KEEP_SEC,
      endSec: next.startSec - GAP_KEEP_SEC,
    };
    if (range.startSec < section.startSec || range.endSec > section.endSec) return;
    tokens.push({
      kind: "gap",
      key: `g:${section.id}:${Math.round(word.endSec * 1000)}`,
      sectionId: section.id,
      range,
      durationSec: gap,
      removed: removalAt(section, (range.startSec + range.endSec) / 2) != null,
    });
  });

  return { tokens, words: flat };
}

export interface SelectionActions {
  wordCount: number;
  /** Source ranges covered by the selected words that are INSIDE the clip —
   *  what Remove / Restore act on. */
  ranges: Array<{ sectionId: string; range: TimeRange }>;
  /** True when every selected in-clip word is already removed. */
  allRemoved: boolean;
  /** Source ranges covered by selected words OUTSIDE the clip — what "Add to
   *  clip" includes. A run that starts right after (or ends right before) an
   *  existing section is stretched to touch it, so the two fuse into one
   *  section instead of leaving a sliver of a cut between them. */
  include: TimeRange[];
  /** Trim a section to start / end at the selection. Null when N/A. */
  startHere: { sectionId: string; window: TimeRange } | null;
  endHere: { sectionId: string; window: TimeRange } | null;
}

/** What can be done with the words at positions [lo, hi]. */
export function selectionActions(
  view: TranscriptView,
  doc: ClipEditDoc,
  lo: number,
  hi: number,
): SelectionActions {
  const all = view.words;
  const plain = all.map((w) => w.word);
  const sectionById = new Map(doc.sections.map((s) => [s.id, s]));
  const ranges: SelectionActions["ranges"] = [];
  const include: TimeRange[] = [];
  let sawInside = false;
  let allRemoved = true;

  // Walk the selection as maximal runs of words sharing a section (or all
  // outside), so a selection spanning clip + not-clip splits cleanly.
  let runStart = lo;
  for (let p = lo; p <= hi + 1; p++) {
    const sameRun =
      p <= hi && all[p] && all[p].sectionId === all[runStart]?.sectionId;
    if (sameRun) continue;
    const first = all[runStart];
    const last = all[p - 1];
    if (first && last) {
      if (first.sectionId) {
        sawInside = true;
        for (let q = runStart; q < p; q++) if (all[q].state === "kept") allRemoved = false;
        const range = rangeForWordRun(plain, runStart, p - 1);
        if (range) ranges.push({ sectionId: first.sectionId, range });
      } else {
        const before = all[runStart - 1];
        const after = all[p];
        const prevSection = before?.sectionId ? sectionById.get(before.sectionId) : undefined;
        const nextSection = after?.sectionId ? sectionById.get(after.sectionId) : undefined;
        include.push({
          startSec: prevSection
            ? Math.min(prevSection.endSec, first.word.startSec)
            : first.word.startSec,
          endSec: nextSection
            ? Math.max(nextSection.startSec, last.word.endSec)
            : last.word.endSec,
        });
      }
    }
    runStart = p;
  }

  const selected = all.slice(lo, hi + 1);
  const firstIn = selected.find((w) => w.sectionId);
  const lastIn = [...selected].reverse().find((w) => w.sectionId);
  const startSection = firstIn?.sectionId ? sectionById.get(firstIn.sectionId) : undefined;
  const endSection = lastIn?.sectionId ? sectionById.get(lastIn.sectionId) : undefined;

  return {
    wordCount: selected.length,
    ranges,
    allRemoved: sawInside && allRemoved,
    include,
    startHere:
      firstIn && startSection && firstIn.word.startSec > startSection.startSec + 0.01
        ? {
            sectionId: startSection.id,
            window: { startSec: firstIn.word.startSec, endSec: startSection.endSec },
          }
        : null,
    endHere:
      lastIn && endSection && lastIn.word.endSec < endSection.endSec - 0.01
        ? {
            sectionId: endSection.id,
            window: { startSec: endSection.startSec, endSec: lastIn.word.endSec },
          }
        : null,
  };
}
