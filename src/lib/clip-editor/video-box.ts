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
  const zoom = video.scalePct / 100;
  /** Offset of an axis that overflows the canvas, panned 0…100 across it. */
  const pan = (size: number, room: number, panPct: number) => 0 - Math.round(((size - room) * panPct) / 100);

  if (video.fit === "cover") {
    // Fill never insets: below 100 it still fills, above it zooms further.
    const s = Math.max(1, zoom);
    const width = even((wide ? H * sourceAspect : W) * s);
    const height = even((wide ? H : W / sourceAspect) * s);
    return {
      x: width > W ? pan(width, W, video.panXPct) : Math.round((W - width) / 2),
      y: height > H ? pan(height, H, video.panYPct ?? 50) : Math.round((H - height) / 2),
      width,
      height,
      radius: 0,
    };
  }

  const width = even((wide ? W : H * sourceAspect) * zoom);
  const height = even((wide ? W / sourceAspect : H) * zoom);
  // yPct puts the video's centre (kept on canvas at or below 100%); once
  // taller than the canvas, yPct pans across the overflow instead (50 =
  // centred either way).
  // Zoomed (but still shorter than the canvas) it may hang off an edge.
  const centreY = (H * video.yPct) / 100 - height / 2;
  const y =
    height > H
      ? pan(height, H, video.yPct)
      : zoom > 1
        ? Math.round(centreY)
        : Math.round(Math.max(0, Math.min(H - height, centreY)));
  const x = width > W ? pan(width, W, video.panXPct) : Math.round((W - width) / 2);
  const inside = width <= W && height <= H;
  return {
    x,
    y,
    width,
    height,
    radius: inside ? Math.round((video.radiusPct / 100) * Math.min(width, height)) : 0,
  };
}

/**
 * The inverse of resolveVideoBox for position: the pan / y values that put
 * the video's centre at canvas point (cx, cy), as near as its fit allows (a
 * contained video narrower than the canvas always stays centred across).
 */
export function centreVideoAt(
  canvas: Pick<Canvas, "width" | "height">,
  video: VideoPlacement,
  source: { width: number; height: number },
  cx: number,
  cy: number,
): Partial<VideoPlacement> {
  const { width: W, height: H } = canvas;
  const { width: w, height: h } = resolveVideoBox(canvas, video, source);
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const panFor = (size: number, room: number, centre: number) => clamp(((size / 2 - centre) / (size - room)) * 100);
  const patch: Partial<VideoPlacement> = {};
  if (w > W) patch.panXPct = panFor(w, W, cx);
  if (video.fit === "contain") patch.yPct = h > H ? panFor(h, H, cy) : clamp((cy / H) * 100);
  else if (h > H) patch.panYPct = panFor(h, H, cy);
  return patch;
}

/** True when the box covers the whole canvas or spills past it — export has
 *  to crop it rather than pad it. */
export function boxOverflows(canvas: Pick<Canvas, "width" | "height">, box: VideoBox): boolean {
  return box.x < 0 || box.y < 0 || box.x + box.width > canvas.width || box.y + box.height > canvas.height;
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
