/**
 * Review notes on the clip editor's timeline (review-notes M3).
 *
 * A note is pinned to a moment of the video people watched on the content
 * page — the LAST RENDER, not the draft in the editor. Once the editor trims
 * or reorders, "0:12 of the render" is somewhere else in the draft, so each
 * note is carried through source time: render output → the source moment
 * that played there → where that moment plays in the draft now.
 */
import { outputToSource, type RenderPlan } from "./plan";

/**
 * Where a note at `atSec` of the rendered video lands on the draft's
 * timeline, or null when its moment was cut from the draft.
 *
 * `rendered` is the plan of the render the note was left on; null when the
 * item's video isn't an editor render (a Descript cut, an upload) — then
 * the time is taken as-is, clamped to the draft's length.
 */
export function placeNoteOnDraft(
  rendered: RenderPlan | null,
  draft: RenderPlan,
  atSec: number,
): number | null {
  if (draft.segments.length === 0) return null;
  if (!rendered) return Math.min(Math.max(atSec, 0), draft.durationSec);

  const at = outputToSource(rendered, atSec);
  if (!at) return null;
  const seg = rendered.segments[at.segmentIndex];
  // Same scene first (a moment can play in two scenes); an uploaded clip
  // only exists in its own scene.
  const sameScene = draft.segments.filter((s) => s.sectionId === seg.sectionId);
  for (const s of sameScene) {
    if (at.sourceSec >= s.sourceStartSec && at.sourceSec < s.sourceEndSec) {
      return s.outStartSec + (at.sourceSec - s.sourceStartSec);
    }
  }
  if (seg.mediaId) return null;
  for (const s of draft.segments) {
    if (!s.mediaId && at.sourceSec >= s.sourceStartSec && at.sourceSec < s.sourceEndSec) {
      return s.outStartSec + (at.sourceSec - s.sourceStartSec);
    }
  }
  return null;
}
