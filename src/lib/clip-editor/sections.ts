/**
 * Document-level section operations.
 *
 * A clip is an ordered list of source sections. In the editor they are always
 * kept in SOURCE order and never overlap — the transcript is the whole video,
 * read top to bottom, and "what plays" is simply the highlighted parts of it
 * in the order you read them. (The doc model itself allows any order; if a
 * reorder feature ever lands, it lifts this invariant deliberately.)
 */
import type { ClipEditDoc, Section, TimeRange } from "./doc";
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
 * sections they fuse into one (keeping every removal made inside them);
 * otherwise it becomes a new section at its place in source order.
 */
export function includeRange(doc: ClipEditDoc, range: TimeRange): ClipEditDoc {
  if (!(range.endSec > range.startSec)) return doc;
  const touching: Section[] = [];
  const others: Section[] = [];
  for (const s of doc.sections) {
    const overlaps =
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
  return {
    ...doc,
    sections: [...others, merged].sort((a, b) => a.startSec - b.startSec),
  };
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
  const sorted = [...doc.sections].sort((a, b) => a.startSec - b.startSec);
  const i = sorted.findIndex((s) => s.id === id);
  if (i < 0) return doc;
  const floor = i > 0 ? sorted[i - 1].endSec : 0;
  const ceiling = i < sorted.length - 1 ? sorted[i + 1].startSec : Number.POSITIVE_INFINITY;
  const clamped = {
    startSec: Math.max(window.startSec, floor),
    endSec: Math.min(window.endSec, ceiling),
  };
  const next = retimeSection(sorted[i], clamped);
  if (next === sorted[i]) return doc;
  sorted[i] = next;
  return { ...doc, sections: sorted };
}
