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
 * Build the `filter_complex` graph that concatenates N already-seeked inputs.
 *
 * Each segment is opened as its OWN input (`-ss <start> -t <dur> -i <src>` in
 * the argv below), so ffmpeg input-seeks straight to each range instead of
 * decoding the whole timeline. The filter then just normalizes PTS per input
 * (`setpts`/`asetpts`, since input-seek can leave a small offset) and concats.
 *
 * This is the key perf property: the original single-input `trim` approach
 * decoded the source from 0 up to the LAST segment's end — for a clip whose
 * body sits minutes into a long podcast, that's minutes of wasted decode (the
 * dead zone between the intro and the body). Input-seeking each range only
 * decodes the seconds we actually keep — matching the proven single-cut path.
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
  segments.forEach((_seg, i) => {
    parts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  parts.push(
    `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[outv][outa]`,
  );
  return parts.join(";");
}

/**
 * Full ffmpeg argv for the multi-segment concat. Each segment becomes its own
 * input-seeked open of the source (`-ss <start> -t <dur> -i <src>`), then the
 * filter concatenates them. Mirrors the codec/flags of the worker's single-cut
 * `ffmpegTrim` (libx264 veryfast + aac + faststart) so the uploaded file is
 * byte-compatible with what Descript already accepts.
 */
export function buildConcatFfmpegArgs(args: {
  inputPath: string;
  outputPath: string;
  segments: ClipSegment[];
}): string[] {
  const filter = buildConcatFilterComplex(args.segments);
  const argv: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
  // One input-seeked open per segment. `-ss`/`-t` BEFORE `-i` = fast input seek
  // (decode starts at the segment, not at 0). `-t` is a duration, which avoids
  // the `-to`-after-`-ss` ambiguity across ffmpeg versions.
  for (const seg of args.segments) {
    argv.push(
      "-ss",
      String(seg.startSec),
      "-t",
      String(seg.endSec - seg.startSec),
      "-i",
      args.inputPath,
    );
  }
  argv.push(
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
  );
  return argv;
}
