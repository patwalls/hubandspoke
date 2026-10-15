/**
 * Document-level section operations.
 *
 * A clip is an ordered list of source sections, played in ARRAY order. They
 * never overlap in the source, but their play order is free — scenes can be
 * dragged around the timeline (`moveSection`) — so nothing here may re-sort
 * `doc.sections` by source time. Source order is only used to find a
 * section's neighbours in the recording (the transcript still reads in
 * recorded order; its part chips show the play order).
 */
import { isSourceSection, type ClipEditDoc, type MediaAsset, type Section, type TimeRange } from "./doc";
import { normalizeRemovals, retimeSection } from "./removals";

const TOUCH_EPSILON_SEC = 0.001;

function sectionId(startSec: number, taken: Set<string>): string {
  const base = `sec-${Math.round(startSec * 1000)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Add a source range to the clip. If it overlaps or touches existing
 * sections they fuse into one (keeping every removal made inside them), in
 * the play-order slot of the first of them; otherwise it becomes a new
 * section, played right after the part that precedes it in the recording
 * (or first, when nothing does).
 */
export function includeRange(doc: ClipEditDoc, range: TimeRange): ClipEditDoc {
  if (!(range.endSec > range.startSec)) return doc;
  const touching: Section[] = [];
  const others: Section[] = [];
  for (const s of doc.sections) {
    // `range` is source time; an uploaded clip's times are on its own file.
    const overlaps =
      isSourceSection(s) &&
      s.startSec <= range.endSec + TOUCH_EPSILON_SEC &&
      s.endSec >= range.startSec - TOUCH_EPSILON_SEC;
    (overlaps ? touching : others).push(s);
  }

  const startSec = Math.min(range.startSec, ...touching.map((s) => s.startSec));
  const endSec = Math.max(range.endSec, ...touching.map((s) => s.endSec));
  const merged: Section = {
    // Keep an existing id when extending, so the player and the trim strip
    // keep following "the same" section through the edit.
    id: touching[0]?.id ?? sectionId(startSec, new Set(others.map((s) => s.id))),
    role: "body",
    startSec,
    endSec,
    removals: normalizeRemovals(
      touching.flatMap((s) => s.removals),
      { startSec, endSec },
    ),
  };
  // `touching` keeps play order, so nothing it holds comes before its first.
  const sections = doc.sections.filter((s) => !touching.includes(s));
  const slot = touching.length > 0 ? doc.sections.indexOf(touching[0]) : afterSourcePredecessor(sections, startSec);
  sections.splice(slot, 0, merged);
  return { ...doc, sections };
}

/** Play-order index just after the section that precedes `startSec` in the
 *  recording (0 when none does). */
function afterSourcePredecessor(sections: Section[], startSec: number): number {
  let best = -1;
  sections.forEach((s, i) => {
    if (isSourceSection(s) && s.startSec < startSec && (best < 0 || s.startSec > sections[best].startSec)) best = i;
  });
  return best + 1;
}

/** Drag a scene on the timeline: play section `id` at position `toIndex`
 *  (0 = first) instead. The footage, its cuts, framing and text go with it. */
export function moveSection(doc: ClipEditDoc, id: string, toIndex: number): ClipEditDoc {
  const from = doc.sections.findIndex((s) => s.id === id);
  if (from < 0) return doc;
  const to = Math.max(0, Math.min(doc.sections.length - 1, toIndex));
  if (to === from) return doc;
  const sections = [...doc.sections];
  const [moved] = sections.splice(from, 1);
  sections.splice(to, 0, moved);
  return { ...doc, sections };
}

/**
 * Move a section's in/out points, stopping at its neighbours so sections
 * can never overlap (drag a handle into the next section and it just stops).
 */
export function retimeSectionInDoc(
  doc: ClipEditDoc,
  id: string,
  window: TimeRange,
): ClipEditDoc {
  const target = doc.sections.find((s) => s.id === id);
  if (!target) return doc;
  // An uploaded clip has no neighbours in its file — it stops at the ends.
  const media = target.mediaId ? doc.media.find((m) => m.id === target.mediaId) : undefined;
  const sorted = target.mediaId
    ? [target]
    : doc.sections.filter(isSourceSection).sort((a, b) => a.startSec - b.startSec);
  const i = sorted.indexOf(target);
  const floor = i > 0 ? sorted[i - 1].endSec : 0;
  const ceiling = i < sorted.length - 1 ? sorted[i + 1].startSec : (media?.durationSec ?? Number.POSITIVE_INFINITY);
  const clamped = {
    startSec: Math.max(window.startSec, floor),
    endSec: Math.min(window.endSec, ceiling),
  };
  const next = retimeSection(sorted[i], clamped);
  if (next === sorted[i]) return doc;
  // Neighbours come from source order; the result keeps the PLAY order.
  return { ...doc, sections: doc.sections.map((s) => (s.id === id ? next : s)) };
}

/** A blade cut can't leave a piece shorter than this. */
export const MIN_SPLIT_PIECE_SEC = 0.1;

/**
 * Blade: cut one section in two at source time `atSec`. Both halves keep
 * playing back to back exactly as before — the cut only makes them separate
 * pieces on the timeline (to select, delete, and later give their own
 * layout). The left half keeps the id. No-op when `atSec` is too close to an
 * edge.
 */
export function splitSectionAt(doc: ClipEditDoc, id: string, atSec: number): ClipEditDoc {
  const i = doc.sections.findIndex((s) => s.id === id);
  const s = doc.sections[i];
  if (!s || atSec < s.startSec + MIN_SPLIT_PIECE_SEC || atSec > s.endSec - MIN_SPLIT_PIECE_SEC) return doc;
  const cut = Math.round(atSec * 1000) / 1000;
  const left = retimeSection(s, { startSec: s.startSec, endSec: cut });
  const right: Section = {
    ...retimeSection(s, { startSec: cut, endSec: s.endSec }),
    id: sectionId(cut, new Set(doc.sections.map((x) => x.id))),
    role: "body",
  };
  const sections = [...doc.sections];
  sections.splice(i, 1, left, right);
  return { ...doc, sections };
}

/**
 * Put an uploaded clip into the edit as its own scene, whole, played at
 * `atIndex` (0 = first). Registers the file in `doc.media` as well.
 */
export function insertMediaScene(doc: ClipEditDoc, media: MediaAsset, atIndex: number): ClipEditDoc {
  const taken = new Set(doc.sections.map((s) => s.id));
  let id = `sec-${media.id}`;
  for (let n = 2; taken.has(id); n++) id = `sec-${media.id}-${n}`;
  const scene: Section = {
    id,
    role: "body",
    startSec: 0,
    endSec: Math.round(media.durationSec * 1000) / 1000,
    removals: [],
    mediaId: media.id,
  };
  const sections = [...doc.sections];
  sections.splice(Math.max(0, Math.min(sections.length, atIndex)), 0, scene);
  // Files no scene plays any more (deleted scenes) are dropped here, so
  // `doc.media` can't fill up; undo still brings them back.
  const used = new Set(sections.map((s) => s.mediaId));
  const kept = doc.media.filter((m) => m.id !== media.id && used.has(m.id));
  return { ...doc, sections, media: [...kept, media] };
}

/** Delete a whole piece of the clip. Its words go back to being "the rest of
 *  the video" (add them again from the transcript, or undo). The clip always
 *  keeps at least one section. */
export function deleteSection(doc: ClipEditDoc, id: string): ClipEditDoc {
  if (doc.sections.length <= 1 || !doc.sections.some((s) => s.id === id)) return doc;
  return { ...doc, sections: doc.sections.filter((s) => s.id !== id) };
}
