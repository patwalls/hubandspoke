/**
 * Stitch a suggested moment into the clip (clip stitching M2, 2026-11-05).
 *
 * The section picker suggests up to 3 short lines from elsewhere in the
 * source per clip (`clip_sections.supporting_moments`, see
 * `src/lib/clip-stitch.ts`), each with a role. Adding one is `includeRange`
 * plus a play-order rule by role, the way editors stitch them by hand:
 *
 *   setup  → plays just before the clip's first body scene (after any intro)
 *   payoff → plays last
 *   detail → its place in the recording, but never ahead of the intro
 *
 * A moment that touches footage already in the clip just extends that scene
 * (includeRange fuses), and is left where it is.
 */
import type { SupportingMoment } from "@/lib/clip-stitch";
import { isSourceSection, type ClipEditDoc, type Section } from "./doc";
import { includeRange, moveSection } from "./sections";

/** Share of a moment that has to be playing for it to count as "in". */
const IN_CLIP_SHARE = 0.8;

export function stitchInMoment(
  doc: ClipEditDoc,
  moment: Pick<SupportingMoment, "role" | "startSec" | "endSec">,
): ClipEditDoc {
  const before = new Set(doc.sections.map((s) => s.id));
  const next = includeRange(doc, { startSec: moment.startSec, endSec: moment.endSec });
  if (next === doc) return doc;
  const added = next.sections.find((s) => !before.has(s.id));
  if (!added) return next; // fused into a scene that was already there
  const others = next.sections.filter((s) => s !== added);
  const firstBody = others.findIndex((s) => s.role === "body");
  const afterIntro = leadingIntroCount(others);
  let to: number;
  if (moment.role === "setup") to = firstBody < 0 ? others.length : firstBody;
  else if (moment.role === "payoff") to = others.length;
  else to = Math.max(next.sections.indexOf(added), afterIntro);
  return moveSection(next, added.id, to);
}

function leadingIntroCount(sections: Section[]): number {
  let n = 0;
  while (n < sections.length && sections[n].role === "intro") n++;
  return n;
}

/** True when at least 80% of the moment's footage is in the clip (cuts
 *  inside a scene don't count against it — trimming a word is still "in"). */
export function momentInClip(doc: ClipEditDoc, moment: Pick<SupportingMoment, "startSec" | "endSec">): boolean {
  const len = moment.endSec - moment.startSec;
  if (!(len > 0)) return false;
  // Overlaps between scenes (pasted copies) are counted once.
  const spans = doc.sections
    .filter(isSourceSection)
    .map((s) => [Math.max(s.startSec, moment.startSec), Math.min(s.endSec, moment.endSec)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let reach = moment.startSec;
  for (const [a, b] of spans) {
    const from = Math.max(a, reach);
    if (b > from) covered += b - from;
    reach = Math.max(reach, b);
  }
  return covered / len >= IN_CLIP_SHARE;
}
