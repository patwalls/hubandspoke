/**
 * Clip assembly helpers — turn an ordered list of source time ranges into the
 * ffmpeg invocation that produces a single re-encoded mp4 playing those ranges
 * back-to-back.
 *
 * Used by the precise-cut worker when a clip idea carries `hookSegments` (a
 * spoken-footage hook pulled from elsewhere in the source, prepended before the
 * main [startSec,endSec] body). The single-range case still goes through the
 * worker's battle-tested `ffmpegTrim` (input-seek + re-encode, the form proven
 * to survive Descript's importer). This module only covers the ≥2-range case.
 */

export interface ClipSegment {
  startSec: number;
  endSec: number;
}

/** A segment is usable only if it's a positive-length range. */
export function isValidSegment(seg: ClipSegment): boolean {
  return (
    Number.isFinite(seg.startSec) &&
    Number.isFinite(seg.endSec) &&
    seg.endSec > seg.startSec &&
    seg.startSec >= 0
  );
}

/**
 * Build the `filter_complex` graph that trims each segment off the single
 * source input and concatenates them in order. Re-encoding the result resets
 * PTS to zero per segment (`setpts`/`asetpts`) and across the join (concat
 * filter), which is exactly what Descript's importer needs — the same property
 * the input-seek + re-encode single-cut path relies on.
 *
 * Pure + exported so the arg mapping is unit-tested without spawning ffmpeg.
 */
export function buildConcatFilterComplex(segments: ClipSegment[]): string {
  if (segments.length < 2) {
    throw new Error(
      `buildConcatFilterComplex needs ≥2 segments, got ${segments.length}`,
    );
  }
  const parts: string[] = [];
  const concatInputs: string[] = [];
  segments.forEach((seg, i) => {
    parts.push(
      `[0:v]trim=start=${seg.startSec}:end=${seg.endSec},setpts=PTS-STARTPTS[v${i}]`,
    );
    parts.push(
      `[0:a]atrim=start=${seg.startSec}:end=${seg.endSec},asetpts=PTS-STARTPTS[a${i}]`,
    );
    concatInputs.push(`[v${i}][a${i}]`);
  });
  parts.push(
    `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[outv][outa]`,
  );
  return parts.join(";");
}

/**
 * Full ffmpeg argv for the multi-segment concat. Mirrors the codec/flags of the
 * worker's single-cut `ffmpegTrim` (libx264 veryfast + aac + faststart) so the
 * uploaded file is byte-compatible with what Descript already accepts.
 */
export function buildConcatFfmpegArgs(args: {
  inputPath: string;
  outputPath: string;
  segments: ClipSegment[];
}): string[] {
  const filter = buildConcatFilterComplex(args.segments);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    args.inputPath,
    "-filter_complex",
    filter,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    args.outputPath,
  ];
}
