/**
 * Where in the source video a clip comes from, as the parts that actually
 * play — "01:38–01:52 + 06:48–07:12", not the hull "01:38–07:12" (which
 * reads as a 5½-minute clip when 38 s play). Feeds the "Created a clip from
 * the queue" activity comment an editor reads to find the moment again.
 *
 * Small removals (fillers, pauses, a manual snip of a few words) don't split
 * a part: pieces closer than `MERGE_GAP_SEC` in the source, played back to
 * back, read as one. Parts come in play order; uploaded clips (no source
 * time) are skipped. Pure.
 */
import { isSourceSection, type ClipEditDoc } from "./doc";
import type { TimeRange } from "./doc";
import { keptRanges } from "./removals";

/** Gaps shorter than this (seconds of source skipped) don't start a new part. */
export const MERGE_GAP_SEC = 3;

/** More parts than this collapse into "+ N more". */
export const MAX_LISTED_PARTS = 4;

export function sourceParts(doc: ClipEditDoc): TimeRange[] {
  const parts: TimeRange[] = [];
  for (const section of doc.sections) {
    if (!isSourceSection(section)) continue;
    for (const range of keptRanges(section)) {
      const prev = parts[parts.length - 1];
      const gap = prev ? range.startSec - prev.endSec : Infinity;
      if (prev && gap >= 0 && gap < MERGE_GAP_SEC) {
        prev.endSec = range.endSec;
      } else {
        parts.push({ startSec: range.startSec, endSec: range.endSec });
      }
    }
  }
  return parts;
}

function mmss(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** "01:38–01:52 + 06:48–07:12"; past `MAX_LISTED_PARTS`, "… + 3 more". */
export function formatSourceParts(parts: TimeRange[]): string {
  const shown = parts.length > MAX_LISTED_PARTS ? parts.slice(0, MAX_LISTED_PARTS - 1) : parts;
  const text = shown.map((p) => `${mmss(p.startSec)}–${mmss(p.endSec)}`).join(" + ");
  const rest = parts.length - shown.length;
  return rest > 0 ? `${text} + ${rest} more` : text;
}
