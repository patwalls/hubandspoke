/**
 * A video slide → the ffmpeg invocation that renders it. Pure (strings only)
 * so the mapping is unit-tested; the worker task spawns it.
 *
 *   input 0: under.png  — page background + everything below the video
 *   input 1: the source, input-seeked to the clip (ranged https read)
 *   input 2: over.png   — everything above the video, transparent
 *
 *   [1:v] fps → scale+crop per coverGeometry → (rounded alpha mask)
 *   [0:v] looped still  → overlay clip → overlay [2:v] looped still
 *        → ASS captions → yuv420p
 *   [1:a] resample → trim
 *
 * Thread caps and the one-frame looped mask are the clip editor's (see
 * clip-editor/ffmpeg-args.ts for the measurements behind them).
 */
import { AUDIO_SAMPLE_RATE } from "@/lib/clip-editor/ffmpeg-args";
import type { DesignVideoElement } from "./doc";
import { coverGeometry } from "./layout";

export const VIDEO_PAGE_FPS = 30;
const DECODER_THREADS = 1;
const FILTER_THREADS = 1;
const ENCODER_THREADS = 2;

function quote(value: string): string {
  if (value.includes("'")) throw new Error(`Path not safe for an ffmpeg filtergraph: ${value}`);
  return `'${value}'`;
}

export interface VideoPageRender {
  video: DesignVideoElement;
  sourceSize: { width: number; height: number };
  canvas: { width: number; height: number };
  assPath: string | null;
  fontsDir: string;
}

export function videoPageFrames(video: DesignVideoElement): number {
  return Math.max(1, Math.round((video.endSec - video.startSec) * VIDEO_PAGE_FPS));
}

export function buildVideoPageFilterGraph(r: VideoPageRender): string {
  const fps = VIDEO_PAGE_FPS;
  const N = videoPageFrames(r.video);
  const { video: v } = r;
  const w = Math.round(v.w);
  const h = Math.round(v.h);
  const g = coverGeometry(r.sourceSize, { w, h }, v.crop, v.fit);
  const gw = Math.max(2, Math.round(g.width / 2) * 2);
  const gh = Math.max(2, Math.round(g.height / 2) * 2);
  const chains: string[] = [];

  const still = (input: number, label: string) =>
    `[${input}:v]format=rgba,loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB,trim=end_frame=${N}[${label}]`;

  // The clip, sized and cropped exactly as the stage shows it.
  const place =
    v.fit === "cover"
      ? `scale=${gw}:${gh}:flags=lanczos,crop=${w}:${h}:${Math.round(-g.left)}:${Math.round(-g.top)}`
      : `scale=${gw}:${gh}:flags=lanczos,pad=${w}:${h}:${Math.round(g.left)}:${Math.round(g.top)}:color=black@0`;
  chains.push(`[1:v]fps=${fps}:start_time=0,setpts=N/${fps}/TB,trim=end_frame=${N},${place},setsar=1,format=rgba[clip]`);

  let clipLabel = "clip";
  if (v.radius > 0) {
    const R = Math.min(v.radius, w / 2, h / 2);
    chains.push(
      `color=c=black:s=${w}x${h}:r=${fps},trim=end_frame=1,format=gray,` +
        `geq=lum='255*clip(${R}+0.5-hypot(max(max(${R}-X-0.5,0),X+0.5-(W-${R})),max(max(${R}-Y-0.5,0),Y+0.5-(H-${R}))),0,1)',` +
        `loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB,trim=end_frame=${N}[mask]`,
    );
    chains.push(`[clip][mask]alphamerge[clipr]`);
    clipLabel = "clipr";
  }

  chains.push(still(0, "under"));
  chains.push(still(2, "over"));
  chains.push(`[under][${clipLabel}]overlay=x=${Math.round(v.x)}:y=${Math.round(v.y)}:format=auto:eof_action=pass[u1]`);
  const burnIn = r.assPath ? `,ass=filename=${quote(r.assPath)}:fontsdir=${quote(r.fontsDir)}` : "";
  chains.push(`[u1][over]overlay=x=0:y=0:format=auto:eof_action=pass${burnIn},format=yuv420p[vout]`);
  chains.push(`[1:a]aresample=${AUDIO_SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${(N / fps).toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
  return chains.join(";\n");
}

export function buildVideoPageArgs(args: {
  video: DesignVideoElement;
  underPath: string;
  overPath: string;
  /** Local path or presigned https URL of the source. */
  input: string;
  filterScriptPath: string;
  outputPath: string;
}): string[] {
  const isHttp = /^https?:\/\//i.test(args.input);
  const dur = Math.max(0.1, args.video.endSec - args.video.startSec);
  const argv = ["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];
  argv.push("-i", args.underPath);
  if (isHttp) argv.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  argv.push("-threads", String(DECODER_THREADS), "-ss", args.video.startSec.toFixed(3), "-t", (dur + 0.5).toFixed(3), "-i", args.input);
  argv.push("-i", args.overPath);
  argv.push(
    "-filter_complex_threads", String(FILTER_THREADS),
    "-filter_complex_script", args.filterScriptPath,
    "-map", "[vout]", "-map", "[aout]",
    "-r", String(VIDEO_PAGE_FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-threads", String(ENCODER_THREADS),
    "-c:a", "aac", "-b:a", "160k", "-ar", String(AUDIO_SAMPLE_RATE),
    "-movflags", "+faststart",
    args.outputPath,
  );
  return argv;
}

/** Args for one still frame of a source at `sec`, scaled to `width` wide. */
/** One still, at the source's own resolution (a 1080p video gives a
 *  1920-wide frame; 4K is capped at `maxWidth`) as a near-lossless JPEG —
 *  these get placed full-bleed and zoomed into, so no downscale here. A
 *  smaller source is never upscaled. */
export function buildFrameGrabArgs(args: { input: string; sec: number; maxWidth: number; outputPath: string }): string[] {
  const isHttp = /^https?:\/\//i.test(args.input);
  const argv = ["-hide_banner", "-loglevel", "error", "-nostats", "-y"];
  if (isHttp) argv.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
  argv.push("-threads", "1", "-ss", args.sec.toFixed(3), "-i", args.input, "-frames:v", "1", "-vf", `scale='min(iw,${args.maxWidth})':-2:flags=lanczos`, "-q:v", "2", args.outputPath);
  return argv;
}
