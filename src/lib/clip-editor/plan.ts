/**
 * compileRenderPlan — resolve a ClipEditDoc into the flat, renderer-facing
 * plan. See the architecture note at the top of doc.ts.
 *
 * Everything that must agree between the browser preview and the ffmpeg
 * export is decided HERE, once: which source frames play, in what order, at
 * what output time, and which caption words show when. Renderers don't make
 * timing decisions of their own.
 *
 * Frame grid. Cuts are snapped to the output frame grid (canvas.fps),
 * measured from each section's seek point. The exporter seeks each section's
 * input to `seekSec`, converts it to constant `fps`, and re-frames audio to
 * exactly one video frame per audio frame — so a cut at frame N is the SAME
 * instant in both streams and A/V sync cannot drift no matter how many filler
 * words were removed. That only works because the plan speaks in whole frames.
 */
import type {
  Canvas,
  CaptionsLayer,
  ClipEditDoc,
  TextLayer,
  VideoPlacement,
} from "./doc";
import { wordEditKey } from "./doc";
import { keptRanges } from "./removals";
import type { EditorWord } from "./words";

/** A kept run shorter than this is an artifact between two removals (a
 *  sliver of breath), not footage anyone chose. ~100ms at 30fps. */
const MIN_SEGMENT_FRAMES = 3;

/** Start a new caption cue when the speaker pauses this long. */
const CUE_BREAK_GAP_SEC = 0.7;
/** How long the last word of a cue lingers when nothing follows it. */
const CUE_TAIL_SEC = 0.25;

export interface PlanSegment {
  sectionId: string;
  /** Index into `plan.inputs`. */
  inputIndex: number;
  /** Snapped source range that plays. */
  sourceStartSec: number;
  sourceEndSec: number;
  /** Where it lands on the output timeline. */
  outStartSec: number;
  outEndSec: number;
  /** [frameStart, frameEnd) on the input's own frame grid (0 = seekSec). */
  frameStart: number;
  frameEnd: number;
}

/** One seeked open of the source file — one per section that has footage. */
export interface PlanInput {
  sectionId: string;
  /** Source time the exporter input-seeks to; frame 0 of this input. */
  seekSec: number;
  /** How much source to read from seekSec. */
  readDurationSec: number;
}

export interface CaptionCueWord {
  text: string;
  /** When this word becomes the highlighted one. */
  outStartSec: number;
  outEndSec: number;
}

export interface CaptionCue {
  outStartSec: number;
  outEndSec: number;
  words: CaptionCueWord[];
}

export interface RenderPlan {
  canvas: Canvas;
  video: VideoPlacement;
  inputs: PlanInput[];
  segments: PlanSegment[];
  totalFrames: number;
  durationSec: number;
  /** Visible, non-empty text layers in z-order. */
  textLayers: TextLayer[];
  /** null when captions are hidden or there is nothing to caption. */
  captions: { layer: CaptionsLayer; cues: CaptionCue[] } | null;
}

export function compileRenderPlan(
  doc: ClipEditDoc,
  words: EditorWord[],
): RenderPlan {
  const fps = doc.canvas.fps;
  const inputs: PlanInput[] = [];
  const segments: PlanSegment[] = [];
  let outFrame = 0;

  for (const section of doc.sections) {
    const kept = keptRanges(section);
    if (kept.length === 0) continue;
    const seekSec = kept[0].startSec;
    const inputIndex = inputs.length;
    const sectionSegments: PlanSegment[] = [];

    for (const range of kept) {
      let frameStart = Math.round((range.startSec - seekSec) * fps);
      const frameEnd = Math.round((range.endSec - seekSec) * fps);
      const prev = sectionSegments[sectionSegments.length - 1];
      // Snapping can make neighbours touch or overlap by a frame — fuse them
      // rather than emit a zero-length cut.
      if (prev && frameStart <= prev.frameEnd) {
        if (frameEnd > prev.frameEnd) prev.frameEnd = frameEnd;
        continue;
      }
      if (prev) frameStart = Math.max(frameStart, prev.frameEnd);
      if (frameEnd - frameStart < MIN_SEGMENT_FRAMES) continue;
      sectionSegments.push({
        sectionId: section.id,
        inputIndex,
        sourceStartSec: 0,
        sourceEndSec: 0,
        outStartSec: 0,
        outEndSec: 0,
        frameStart,
        frameEnd,
      });
    }
    if (sectionSegments.length === 0) continue;

    for (const seg of sectionSegments) {
      const frames = seg.frameEnd - seg.frameStart;
      seg.sourceStartSec = seekSec + seg.frameStart / fps;
      seg.sourceEndSec = seekSec + seg.frameEnd / fps;
      seg.outStartSec = outFrame / fps;
      outFrame += frames;
      seg.outEndSec = outFrame / fps;
      segments.push(seg);
    }
    const lastFrame = sectionSegments[sectionSegments.length - 1].frameEnd;
    inputs.push({
      sectionId: section.id,
      seekSec,
      // One extra second so the decoder never starves the final frames.
      readDurationSec: lastFrame / fps + 1,
    });
  }

  const textLayers = doc.layers.filter(
    (l): l is TextLayer =>
      l.type === "text" && l.visible && l.text.trim().length > 0,
  );

  const captionsLayer = doc.layers.find(
    (l): l is CaptionsLayer => l.type === "captions" && l.visible,
  );
  const cues = captionsLayer
    ? buildCaptionCues(doc, segments, words, captionsLayer)
    : [];

  return {
    canvas: doc.canvas,
    video: doc.video,
    inputs,
    segments,
    totalFrames: outFrame,
    durationSec: outFrame / fps,
    textLayers,
    captions:
      captionsLayer && cues.length > 0 ? { layer: captionsLayer, cues } : null,
  };
}

interface TimedWord {
  text: string;
  outStartSec: number;
  outEndSec: number;
  segmentIndex: number;
}

function buildCaptionCues(
  doc: ClipEditDoc,
  segments: PlanSegment[],
  words: EditorWord[],
  layer: CaptionsLayer,
): CaptionCue[] {
  // Walk segments in OUTPUT order and pull the words each one plays. Going
  // segment-first (not word-first) is what makes a source moment that appears
  // twice — an intro line that's also inside the body — caption both times.
  const timed: TimedWord[] = [];
  segments.forEach((seg, segmentIndex) => {
    for (const w of words) {
      const mid = (w.startSec + w.endSec) / 2;
      if (mid < seg.sourceStartSec || mid >= seg.sourceEndSec) continue;
      const text = (doc.wordEdits[wordEditKey(w.startSec)] ?? w.text).trim();
      if (!text) continue;
      const start = Math.max(w.startSec, seg.sourceStartSec);
      const end = Math.min(Math.max(w.endSec, start), seg.sourceEndSec);
      timed.push({
        text,
        outStartSec: seg.outStartSec + (start - seg.sourceStartSec),
        outEndSec: seg.outStartSec + (end - seg.sourceStartSec),
        segmentIndex,
      });
    }
  });

  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  let chars = 0;
  for (const w of timed) {
    const prev = current[current.length - 1];
    const crossesSection =
      prev &&
      segments[prev.segmentIndex].sectionId !==
        segments[w.segmentIndex].sectionId;
    const shouldBreak =
      current.length > 0 &&
      (current.length >= layer.maxWordsPerCue ||
        chars + 1 + w.text.length > layer.maxCharsPerCue ||
        w.outStartSec - prev!.outEndSec > CUE_BREAK_GAP_SEC ||
        crossesSection);
    if (shouldBreak) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    chars += (current.length > 0 ? 1 : 0) + w.text.length;
    current.push(w);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, gi) => {
    const next = groups[gi + 1];
    const last = group[group.length - 1];
    const cueStart = group[0].outStartSec;
    const cueEnd = Math.max(
      cueStart + 0.05,
      Math.min(
        last.outEndSec + CUE_TAIL_SEC,
        next ? next[0].outStartSec : Number.POSITIVE_INFINITY,
      ),
    );
    return {
      outStartSec: cueStart,
      outEndSec: cueEnd,
      // Each word stays highlighted until the next one starts, so the
      // highlight never blinks off mid-cue.
      words: group.map((w, wi) => ({
        text: w.text,
        outStartSec: wi === 0 ? cueStart : w.outStartSec,
        outEndSec: wi < group.length - 1 ? group[wi + 1].outStartSec : cueEnd,
      })),
    };
  });
}

// ─── Time mapping (used by the player, timeline and transcript) ─────────────

/** Output time → the segment playing then and the source time inside it. */
export function outputToSource(
  plan: RenderPlan,
  outSec: number,
): { segmentIndex: number; sourceSec: number } | null {
  if (plan.segments.length === 0) return null;
  const t = Math.min(Math.max(outSec, 0), plan.durationSec);
  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i];
    if (t < seg.outEndSec || i === plan.segments.length - 1) {
      const offset = Math.min(
        Math.max(t - seg.outStartSec, 0),
        seg.outEndSec - seg.outStartSec,
      );
      return { segmentIndex: i, sourceSec: seg.sourceStartSec + offset };
    }
  }
  return null;
}

/**
 * Source time → output time. When the moment was cut, returns where playback
 * resumes after it (the next segment's start), so clicking a removed word
 * still puts the playhead somewhere sensible. `sectionId` disambiguates a
 * source moment that plays in more than one section.
 */
export function sourceToOutput(
  plan: RenderPlan,
  sourceSec: number,
  sectionId?: string,
): number | null {
  const candidates = sectionId
    ? plan.segments.filter((s) => s.sectionId === sectionId)
    : plan.segments;
  for (const seg of candidates) {
    if (sourceSec >= seg.sourceStartSec && sourceSec < seg.sourceEndSec) {
      return seg.outStartSec + (sourceSec - seg.sourceStartSec);
    }
  }
  for (const seg of candidates) {
    if (seg.sourceStartSec >= sourceSec) return seg.outStartSec;
  }
  return null;
}
