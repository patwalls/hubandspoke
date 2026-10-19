/**
 * Document-level section operations.
 *
 * A clip is an ordered list of source sections, played in ARRAY order. Their
 * play order is free — scenes can be dragged around the timeline
 * (`moveSection`) — so nothing here may re-sort `doc.sections` by source
 * time. Source order is only used to find a section's neighbours in the
 * recording (the transcript still reads in recorded order; its part chips
 * show the play order).
 *
 * Sections normally never overlap in the source. The exception is a COPY:
 * text pasted from the transcript (`pastePieces`) plays footage that is
 * already in the clip. `primarySourceSections` picks the sections that own
 * the footage; copies are skipped when fusing (`includeRange`) and never
 * fence a trim in (`retimeSectionInDoc`).
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
  const primary = primarySourceSections(doc.sections);
  for (const s of doc.sections) {
    // `range` is source time; an uploaded clip's times are on its own file.
    // A copy is left alone — fusing it would swallow its original too.
    const overlaps =
      isSourceSection(s) &&
      primary.has(s.id) &&
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
 * never overlap (drag a handle into the next section and it just stops).
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
  const others = target.mediaId ? [] : doc.sections.filter((s) => s !== target && isSourceSection(s));
  // Neighbours are the sections wholly before / after it in the recording.
  // A copy of the same footage overlaps it, so it never fences it in.
  const floor = Math.max(0, ...others.filter((s) => s.endSec <= target.startSec + TOUCH_EPSILON_SEC).map((s) => s.endSec));
  const ceiling = Math.min(
    media?.durationSec ?? Number.POSITIVE_INFINITY,
    ...others.filter((s) => s.startSec >= target.endSec - TOUCH_EPSILON_SEC).map((s) => s.startSec),
  );
  const clamped = {
    startSec: Math.max(window.startSec, floor),
    endSec: Math.min(window.endSec, ceiling),
  };
  const next = retimeSection(target, clamped);
  if (next === target) return doc;
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

/**
 * The source sections that own their footage: the heaviest (by duration)
 * set that doesn't overlap in the recording. Every other source section is
 * a copy of footage already in the clip. On a tie the one played first
 * wins. With no copies this is every source section.
 */
export function primarySourceSections(sections: Section[]): Set<string> {
  const playIndex = new Map(sections.map((s, i) => [s.id, i]));
  const sorted = sections
    .filter(isSourceSection)
    .sort((a, b) => a.endSec - b.endSec || a.startSec - b.startSec || playIndex.get(a.id)! - playIndex.get(b.id)!);
  // Weighted interval scheduling: best[i] = heaviest set among sorted[0..i).
  const best = [0];
  const take: boolean[] = [];
  const prevOf: number[] = [];
  sorted.forEach((s, i) => {
    let p = i;
    while (p > 0 && sorted[p - 1].endSec > s.startSec + TOUCH_EPSILON_SEC) p--;
    prevOf.push(p);
    const withIt = best[p] + (s.endSec - s.startSec);
    take.push(withIt > best[i]);
    best.push(Math.max(withIt, best[i]));
  });
  const out = new Set<string>();
  for (let i = sorted.length; i > 0; ) {
    if (take[i - 1]) {
      out.add(sorted[i - 1].id);
      i = prevOf[i - 1];
    } else i--;
  }
  return out;
}

/** The doc schema's cap on sections. */
const MAX_SECTIONS = 20;

/** A piece of the clip on the editor's clipboard: a window of one section's
 *  footage with the cuts and framing inside it — not the section itself. */
export type ClipPiece = Pick<Section, "startSec" | "endSec" | "removals" | "video" | "mediaId">;

/** Copy: the pieces of footage under `ranges` (the selected words), in the
 *  order given. */
export function copyPieces(doc: ClipEditDoc, ranges: Array<{ sectionId: string; range: TimeRange }>): ClipPiece[] {
  const out: ClipPiece[] = [];
  for (const { sectionId, range } of ranges) {
    const s = doc.sections.find((x) => x.id === sectionId);
    if (!s) continue;
    const window = { startSec: Math.max(s.startSec, range.startSec), endSec: Math.min(s.endSec, range.endSec) };
    if (!(window.endSec > window.startSec)) continue;
    const { startSec, endSec, removals, video, mediaId } = retimeSection(s, window);
    out.push({ startSec, endSec, removals, ...(video ? { video } : {}), ...(mediaId ? { mediaId } : {}) });
  }
  return out;
}

/**
 * Paste (Descript-style): play `pieces` as new scenes where the cursor is —
 * at source time `atSec` inside section `sectionId`, which is split there.
 * An `atSec` at (or past) an edge pastes before / after the section without
 * splitting, so pass -Infinity / Infinity for "before" / "after". What was
 * copied stays where it was. Unchanged when it would go past the scene cap.
 */
export function pastePieces(
  doc: ClipEditDoc,
  pieces: ClipPiece[],
  at: { sectionId: string; atSec: number },
): ClipEditDoc {
  // A piece from an uploaded clip that has since left the edit can't play.
  const playable = pieces.filter((p) => !p.mediaId || doc.media.some((m) => m.id === p.mediaId));
  const i = doc.sections.findIndex((s) => s.id === at.sectionId);
  if (i < 0 || playable.length === 0) return doc;
  const s = doc.sections[i];
  let d = doc;
  let insertAt = i + 1;
  if (at.atSec <= s.startSec + MIN_SPLIT_PIECE_SEC) insertAt = i;
  else if (at.atSec < s.endSec - MIN_SPLIT_PIECE_SEC) d = splitSectionAt(doc, s.id, at.atSec);
  if (d.sections.length + playable.length > MAX_SECTIONS) return doc;
  const taken = new Set(d.sections.map((x) => x.id));
  const scenes = playable.map((p): Section => {
    const id = sectionId(p.startSec, taken);
    taken.add(id);
    return { ...p, id, role: "body" };
  });
  const sections = [...d.sections];
  sections.splice(insertAt, 0, ...scenes);
  return { ...d, sections };
}
