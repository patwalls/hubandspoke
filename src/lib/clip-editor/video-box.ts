/**
 * Where the source video sits on the canvas, in canvas pixels.
 *
 * ONE function, used by both the React stage and the ffmpeg exporter, so the
 * two cannot disagree about placement, inset or corner radius. Everything is
 * derived from the doc's percentages plus the source's pixel dimensions.
 */
import type { Canvas, VideoPlacement } from "./doc";

export interface VideoBox {
  /** Top-left of the (possibly overflowing, for cover) video, canvas px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius in px. Always 0 for cover — the video fills the canvas. */
  radius: number;
}

/** Even numbers only: yuv420 chroma is subsampled 2×, and libx264 rejects
 *  odd dimensions outright. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function resolveVideoBox(
  canvas: Pick<Canvas, "width" | "height">,
  video: VideoPlacement,
  source: { width: number; height: number },
): VideoBox {
  const { width: W, height: H } = canvas;
  const sourceAspect = source.width / source.height;
  const wide = sourceAspect > W / H;

  if (video.fit === "cover") {
    const width = wide ? even(H * sourceAspect) : W;
    const height = wide ? H : even(W / sourceAspect);
    return {
      x: -Math.round(((width - W) * video.panXPct) / 100),
      y: -Math.round((height - H) / 2),
      width,
      height,
      radius: 0,
    };
  }

  const scale = video.scalePct / 100;
  const width = even((wide ? W : H * sourceAspect) * scale);
  const height = even((wide ? W / sourceAspect : H) * scale);
  const y = Math.round(
    Math.max(0, Math.min(H - height, (H * video.yPct) / 100 - height / 2)),
  );
  return {
    x: Math.round((W - width) / 2),
    y,
    width,
    height,
    radius: Math.round((video.radiusPct / 100) * Math.min(width, height)),
  };
}

/**
 * Pull the display dimensions of the first video stream out of `ffmpeg -i`
 * stderr. We have no ffprobe (the @ffmpeg-installer package ships ffmpeg
 * only), and this banner format has been stable for a decade.
 *
 * Honors rotation metadata: a phone clip stored 1920×1080 with a 90° display
 * matrix is DISPLAYED 1080×1920, and ffmpeg's autorotate hands our filters
 * the rotated frame — so the rotated size is the one layout needs.
 */
export function parseSourceDimensions(
  ffmpegStderr: string,
): { width: number; height: number } | null {
  const lines = ffmpegStderr.split("\n");
  const i = lines.findIndex((l) => /Stream #\d+:\d+.*: Video:/.test(l));
  if (i < 0) return null;
  const m = /,\s*(\d{2,5})x(\d{2,5})(?=[\s,\[])/.exec(lines[i]);
  if (!m) return null;
  let width = Number(m[1]);
  let height = Number(m[2]);

  // Rotation is reported on the lines under the stream, until the next one.
  for (let j = i + 1; j < lines.length && !/Stream #\d+:\d+/.test(lines[j]); j++) {
    const r =
      /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(lines[j]) ??
      /^\s*rotate\s*:\s*(-?\d+)/.exec(lines[j]);
    if (r && Math.abs(Math.round(Number(r[1]))) % 180 === 90) {
      [width, height] = [height, width];
      break;
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

/** "Duration: 00:10:12.34" from the same `ffmpeg -i` banner. */
export function parseSourceDuration(ffmpegStderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(ffmpegStderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
