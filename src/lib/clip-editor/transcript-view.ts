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
import { isSourceSection, wordEditKey } from "./doc";
import { removalAt } from "./removals";
import { isWordInRange, mediaEditorWords, rangeForWordRun, type EditorWord } from "./words";

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
  /** Seconds shaved off this (kept) word's start / end — "trim" removals
   *  that cover an edge but not the middle. 0 when untouched. */
  trimStartSec: number;
  trimEndSec: number;
  /** "main" for everything shown in recorded order; a moved scene's id for
   *  the words of a scene dragged out of order (shown where it plays). A
   *  highlight never spans two blocks — they aren't next to each other. */
  block: string;
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

/** Marks a change of speaker, inline — only present on multi-speaker audio. */
export interface ViewSpeakerChange {
  kind: "speaker";
  key: string;
  speakerId: string;
}

export type ViewToken = ViewWord | ViewGap | ViewMarker | ViewSpeakerChange;

export interface TranscriptView {
  /** Display order — recorded order, except scenes dragged out of order on
   *  the timeline, whose text shows where they now play. */
  tokens: ViewToken[];
  /** Every word of the source, in SOURCE order (`words[pos].pos === pos`). */
  words: ViewWord[];
  /** Word positions in display order (what ← / → walk). */
  displayOrder: number[];
}

export function buildTranscriptView(
  doc: ClipEditDoc,
  words: EditorWord[],
): TranscriptView {
  // The source's words land in its scenes; uploaded clips' words (on other
  // files) are added per scene below.
  const sourceSections = doc.sections.filter(isSourceSection);
  const sections = [...sourceSections].sort((a, b) => a.startSec - b.startSec);
  const tokens: ViewToken[] = [];
  const flat: ViewWord[] = [];
  const marked = new Set<string>();
  let si = 0;

  const sectionFor = (mid: number): Section | null => {
    while (si < sections.length && mid >= sections[si].endSec) si++;
    const s = sections[si];
    return s && mid >= s.startSec ? s : null;
  };

  // One word (and the pause after it) of `section`. `prev`/`next` are its
  // neighbours on the same file.
  const emit = (word: EditorWord, section: Section | null, prev?: EditorWord, next?: EditorWord) => {
    const mid = (word.startSec + word.endSec) / 2;
    const removal = section ? removalAt(section, mid) : null;
    const correction = doc.wordEdits[wordEditKey(word.startSec, word.mediaId)];

    if (section && !marked.has(section.id)) {
      marked.add(section.id);
      tokens.push({
        kind: "marker",
        key: `m:${section.id}`,
        sectionId: section.id,
        // Play order — scenes can be dragged out of recorded order.
        index: doc.sections.indexOf(section) + 1,
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
      ...(section && !removal ? wordTrims(section, word, prev, next) : { trimStartSec: 0, trimEndSec: 0 }),
      block: "main",
    };
    flat.push(view);
    tokens.push(view);

    // A pause chip, only for pauses wholly inside one section.
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
  };

  let lastSpeaker: string | undefined;
  words.forEach((word, i) => {
    if (word.speakerId && word.speakerId !== lastSpeaker) {
      tokens.push({ kind: "speaker", key: `s:${i}`, speakerId: word.speakerId });
      lastSpeaker = word.speakerId;
    }
    emit(word, sectionFor((word.startSec + word.endSec) / 2), words[i - 1], words[i + 1]);
  });

  // An uploaded clip's scene shows its own file's words — those inside its
  // trim. They never sit in recorded order with the source's, so
  // reorderForPlay lifts them to where the scene plays.
  doc.sections.forEach((section) => {
    const slot = doc.media.findIndex((m) => m.id === section.mediaId);
    if (slot < 0) return;
    const own = mediaEditorWords(doc.media[slot], slot).filter((w) => isWordInRange(w, section));
    own.forEach((word, i) => emit(word, section, own[i - 1], own[i + 1]));
  });

  return reorderForPlay(doc, tokens, flat);
}

/**
 * Scenes dragged out of recorded order on the timeline: lift each one's text
 * (marker, words, pauses) to right after the scene that plays before it. The
 * scenes that stay put are the largest (by duration) set whose play order
 * agrees with the recording, so the body never jumps — only what you moved
 * moves. With nothing out of order this returns the tokens untouched.
 */
function reorderForPlay(doc: ClipEditDoc, tokens: ViewToken[], flat: ViewWord[]): TranscriptView {
  // Only the source's scenes have a recorded order; uploaded clips always
  // follow whatever plays before them.
  const anchored = inOrderSections(doc.sections.filter(isSourceSection));
  const plain = () => ({ tokens, words: flat, displayOrder: flat.map((w) => w.pos) });
  if (anchored.size === doc.sections.length) return plain();

  const ownerOf = (t: ViewToken): string | null =>
    t.kind === "word" ? t.sectionId : t.kind === "gap" || t.kind === "marker" ? t.sectionId : null;
  // Pull out moved scenes' tokens; speaker labels are recomputed below.
  const main: ViewToken[] = [];
  const moved = new Map<string, ViewToken[]>();
  for (const t of tokens) {
    if (t.kind === "speaker") continue;
    const owner = ownerOf(t);
    if (owner && !anchored.has(owner)) {
      const list = moved.get(owner);
      if (list) list.push(t);
      else moved.set(owner, [t]);
      if (t.kind === "word") t.block = owner;
    } else main.push(t);
  }
  // Which moved scenes follow which anchored one, in play order ("" = before
  // the first anchored scene).
  const followers = new Map<string, string[]>();
  let lead = "";
  for (const sec of doc.sections) {
    if (anchored.has(sec.id)) lead = sec.id;
    else followers.set(lead, [...(followers.get(lead) ?? []), sec.id]);
  }
  const lastIndexOf = new Map<string, number>();
  main.forEach((t, i) => {
    const o = ownerOf(t);
    if (o) lastIndexOf.set(o, i);
  });
  const firstAnchored = main.findIndex((t) => t.kind === "marker");
  const out: ViewToken[] = [];
  const emit = (ids: string[] | undefined) => ids?.forEach((id) => out.push(...(moved.get(id) ?? [])));
  main.forEach((t, i) => {
    if (i === firstAnchored) emit(followers.get(""));
    out.push(t);
    const o = ownerOf(t);
    if (o && lastIndexOf.get(o) === i) emit(followers.get(o));
  });
  if (firstAnchored < 0) emit(followers.get(""));

  // Speaker labels for the new reading order.
  const withSpeakers: ViewToken[] = [];
  let lastSpeaker: string | undefined;
  for (const t of out) {
    if (t.kind === "word" && t.word.speakerId && t.word.speakerId !== lastSpeaker) {
      withSpeakers.push({ kind: "speaker", key: `s:${t.pos}`, speakerId: t.word.speakerId });
      lastSpeaker = t.word.speakerId;
    }
    withSpeakers.push(t);
  }
  const displayOrder = withSpeakers.flatMap((t) => (t.kind === "word" ? [t.pos] : []));
  return { tokens: withSpeakers, words: flat, displayOrder };
}

/** The scenes that stay where they are in the recording: the heaviest (by
 *  duration) subsequence of the play order that is also in source order. */
function inOrderSections(sections: Section[]): Set<string> {
  const n = sections.length;
  const best: number[] = [];
  const prev: number[] = [];
  for (let i = 0; i < n; i++) {
    const len = sections[i].endSec - sections[i].startSec;
    best[i] = len;
    prev[i] = -1;
    for (let j = 0; j < i; j++) {
      if (sections[j].startSec < sections[i].startSec && best[j] + len > best[i]) {
        best[i] = best[j] + len;
        prev[i] = j;
      }
    }
  }
  const out = new Set<string>();
  let k = -1;
  for (let i = 0; i < n; i++) if (k < 0 || best[i] > best[k]) k = i;
  for (; k >= 0; k = prev[k]) out.add(sections[k].id);
  return out;
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

/** How much of a kept word's edges is shaved off by removals that don't
 *  reach its middle. */
export function wordTrims(section: Section, word: EditorWord, prev?: EditorWord, next?: EditorWord): { trimStartSec: number; trimEndSec: number } {
  const mid = (word.startSec + word.endSec) / 2;
  // A "trim" cut that runs into the gap beside the word counts too (that
  // gap is the word's — see word-trim.ts), measured from the gap's far edge.
  const before = prev ? Math.max(prev.endSec, word.startSec - 1) : word.startSec - 1;
  const after = next ? Math.min(next.startSec, word.endSec + 1) : word.endSec + 1;
  // Removal edges are rounded to the millisecond; word times are not.
  const E = 2e-3;
  let trimStartSec = 0;
  let trimEndSec = 0;
  for (const r of section.removals) {
    if (r.startSec <= word.startSec + E && r.endSec > word.startSec + E && r.endSec <= mid) trimStartSec = Math.max(trimStartSec, r.endSec - word.startSec);
    else if (r.reason === "trim" && r.startSec <= before + E && r.endSec > before && r.endSec <= word.startSec + E) trimStartSec = Math.max(trimStartSec, r.endSec - before);
    if (r.endSec >= word.endSec - E && r.startSec < word.endSec - E && r.startSec >= mid) trimEndSec = Math.max(trimEndSec, word.endSec - r.startSec);
    else if (r.reason === "trim" && r.endSec >= after - E && r.startSec < after && r.startSec >= word.endSec - E) trimEndSec = Math.max(trimEndSec, after - r.startSec);
  }
  return { trimStartSec: round3(trimStartSec), trimEndSec: round3(trimEndSec) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** How far a single tidy press shaves. */
export const TRIM_STEP_SEC = 0.08;

/**
 * Shave `step` more off a word's edge (never past its middle). Returns the
 * removal range to add, or null when the edge is as short as it can get.
 */
export function trimRangeFor(word: EditorWord, edge: "start" | "end", current: number, step = TRIM_STEP_SEC): TimeRange | null {
  const half = (word.endSec - word.startSec) / 2 - 0.02;
  const next = Math.min(half, current + step);
  if (next <= current + 0.005) return null;
  return edge === "start" ? { startSec: word.startSec, endSec: round3(word.startSec + next) } : { startSec: round3(word.endSec - next), endSec: word.endSec };
}

/**
 * The highlighted words as plain text, for the clipboard. Struck words are
 * left out (you copy what the clip says) unless everything highlighted is
 * struck — then you get exactly what you highlighted.
 */
export function selectionText(view: TranscriptView, lo: number, hi: number): string {
  const picked = view.words.slice(Math.max(0, lo), hi + 1);
  const said = picked.filter((w) => w.state !== "removed");
  return (said.length ? said : picked).map((w) => w.text).join(" ");
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
        // Only a source neighbour can be fused with — an uploaded clip's
        // times are on another file.
        const source = (w: ViewWord | undefined) => (w?.sectionId && !w.word.mediaId ? sectionById.get(w.sectionId) : undefined);
        const prevSection = source(before);
        const nextSection = source(after);
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
