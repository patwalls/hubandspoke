/**
 * Range algebra for a section's `removals`.
 *
 * Invariant every function here preserves: removals are sorted by startSec,
 * never overlap, and each lies inside the section window. Adjacent removals
 * with the SAME reason are merged; adjacent removals with different reasons
 * stay separate so "restore all filler words" still knows which is which.
 *
 * All functions are pure and return new arrays — the editor store relies on
 * that for undo/redo.
 */
import type { Removal, RemovalReason, Section, TimeRange } from "./doc";

/** Ranges shorter than this are noise from float math, not an edit. */
const EPSILON_SEC = 0.001;

function isRealRange(r: TimeRange): boolean {
  return r.endSec - r.startSec > EPSILON_SEC;
}

/** Remove `cut` from every removal, splitting any that straddle it. */
export function subtractRange(removals: Removal[], cut: TimeRange): Removal[] {
  const out: Removal[] = [];
  for (const r of removals) {
    if (cut.endSec <= r.startSec || cut.startSec >= r.endSec) {
      out.push(r);
      continue;
    }
    const left = { ...r, endSec: Math.min(r.endSec, cut.startSec) };
    const right = { ...r, startSec: Math.max(r.startSec, cut.endSec) };
    if (isRealRange(left)) out.push(left);
    if (isRealRange(right)) out.push(right);
  }
  return out;
}

/** Sort + merge touching/overlapping removals that share a reason. */
export function normalizeRemovals(
  removals: Removal[],
  window: TimeRange,
): Removal[] {
  const clamped = removals
    .map((r) => ({
      ...r,
      startSec: Math.max(r.startSec, window.startSec),
      endSec: Math.min(r.endSec, window.endSec),
    }))
    .filter(isRealRange)
    .sort((a, b) => a.startSec - b.startSec);

  const out: Removal[] = [];
  for (const r of clamped) {
    const prev = out[out.length - 1];
    if (prev && r.startSec <= prev.endSec + EPSILON_SEC) {
      if (prev.reason === r.reason) {
        prev.endSec = Math.max(prev.endSec, r.endSec);
        continue;
      }
      // Different reason overlapping the previous one: the earlier removal
      // keeps its span, the later one starts where it ends.
      const trimmed = { ...r, startSec: Math.max(r.startSec, prev.endSec) };
      if (isRealRange(trimmed)) out.push(trimmed);
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/** Remove a range. The new removal wins over whatever it overlaps. */
export function addRemoval(
  section: Section,
  range: TimeRange,
  reason: RemovalReason,
): Section {
  const removals = normalizeRemovals(
    [...subtractRange(section.removals, range), { ...range, reason }],
    section,
  );
  return { ...section, removals };
}

/** Restore a range — whatever was removed inside it plays again. */
export function restoreRange(section: Section, range: TimeRange): Section {
  return {
    ...section,
    removals: normalizeRemovals(subtractRange(section.removals, range), section),
  };
}

/** Drop every removal with this reason (undo a bulk action as a group). */
export function restoreReason(
  section: Section,
  reason: RemovalReason,
): Section {
  return {
    ...section,
    removals: section.removals.filter((r) => r.reason !== reason),
  };
}

/** Move a section's in/out points, re-clamping its removals to the new
 *  window. Extending a trim never resurrects removals — they were clamped
 *  away when the window shrank, which matches what the editor saw. */
export function retimeSection(section: Section, window: TimeRange): Section {
  if (!isRealRange(window)) return section;
  return {
    ...section,
    startSec: window.startSec,
    endSec: window.endSec,
    removals: normalizeRemovals(section.removals, window),
  };
}

/** The ranges of this section that actually play, in order. */
export function keptRanges(section: Section): TimeRange[] {
  const out: TimeRange[] = [];
  let cursor = section.startSec;
  for (const r of normalizeRemovals(section.removals, section)) {
    if (r.startSec > cursor + EPSILON_SEC) {
      out.push({ startSec: cursor, endSec: r.startSec });
    }
    cursor = Math.max(cursor, r.endSec);
  }
  if (section.endSec > cursor + EPSILON_SEC) {
    out.push({ startSec: cursor, endSec: section.endSec });
  }
  return out;
}

/** The removal covering time `t`, if any. */
export function removalAt(section: Section, t: number): Removal | null {
  for (const r of section.removals) {
    if (t >= r.startSec && t < r.endSec) return r;
  }
  return null;
}
