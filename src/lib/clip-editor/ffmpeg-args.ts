/**
 * RenderPlan → the ffmpeg invocation that exports it. Pure: builds strings,
 * spawns nothing, so the whole mapping is unit-tested.
 *
 * Shape of the graph:
 *
 *   per plan input (one seeked open of the source per section)
 *     video: fps → select(kept frames) → setpts
 *     audio: aresample → asetnsamples(one video frame of samples) → aselect → asetpts
 *   concat the inputs → place on the canvas (scale + pad | crop)
 *     → overlay each image layer (logos; extra still-image inputs) → burn in ASS
 *
 * Why select/aselect by FRAME NUMBER instead of trim+concat per cut: a clip
 * with filler words removed has dozens of cuts. One decode pass with a
 * frame-number predicate scales to hundreds of cuts without hundreds of
 * filter branches, and because audio is re-framed so each audio frame spans
 * exactly one video frame, `between(n,a,b)` selects the identical instant in
 * both streams — sync cannot drift (see plan.ts, "Frame grid").
 */
import { sectionOutWindow, type PlanSegment, type RenderPlan } from "./plan";
import { boxOverflows, resolveVideoBox, type VideoBox } from "./video-box";

export const AUDIO_SAMPLE_RATE = 48000;

/**
 * Thread caps. ffmpeg sizes its thread pools from the core count, and a
 * Heroku dyno REPORTS 8 cores while giving you a slice of one — so by default
 * the decoders and x264 each spin up 8 threads' worth of 1080p frame buffers
 * for no speed at all. Measured on a hubandspoke dyno (2026-09-17, 40s clip,
 * 1080×1920, prod's 2018 static ffmpeg):
 *
 *   default (8 threads)             14s   457 MB peak RSS
 *   decode 1 / filter 1 / x264 2    15s   229 MB   ← these values
 *   decode 1 / filter 1 / x264 1    29s   185 MB
 *
 * Half the memory for one second. On a 512 MB dyno that also holds the
 * worker's Node process, that is the difference between fine and R14/R15.
 * Revisit if renders move to a bigger box.
 */
const DECODER_THREADS = 1;
const FILTER_THREADS = 1;
const ENCODER_THREADS = 2;

function quote(value: string): string {
  if (value.includes("'")) {
    throw new Error(`Path not safe for an ffmpeg filtergraph: ${value}`);
  }
  return `'${value}'`;
}

function framePredicate(segments: PlanSegment[]): string {
  return segments
    .map((s) => `between(n,${s.frameStart},${s.frameEnd - 1})`)
    .join("+");
}

function hexToFfmpegColor(hex: string): string {
  return `0x${hex.slice(1)}`;
}

export function buildFilterGraph(
  plan: RenderPlan,
  opts: {
    assPath: string | null;
    fontsDir: string;
    /** Display size of the source (see `parseSourceDimensions`). Without it
     *  the graph falls back to aspect expressions and cannot inset/round. */
    sourceSize?: { width: number; height: number } | null;
    /** Image layers as extra inputs, in the order `buildRenderArgs` adds
     *  them after the video inputs (one per `plan.imageLayers` entry). */
    imageCount?: number;
  },
): string {
  const { width: W, height: H, fps } = plan.canvas;
  if (plan.inputs.length === 0 || plan.totalFrames === 0) {
    throw new Error("Nothing to render: the edit removes all footage");
  }
  const samplesPerFrame = AUDIO_SAMPLE_RATE / fps;
  if (!Number.isInteger(samplesPerFrame)) {
    throw new Error(
      `fps ${fps} does not divide ${AUDIO_SAMPLE_RATE}Hz into whole audio frames`,
    );
  }

  const chains: string[] = [];
  const bg = hexToFfmpegColor(plan.canvas.background);

  // Every scene framed alike (the common case, and every clip made before
  // per-scene framing) = place once, after the concat. Scenes framed
  // differently = place each input on its own, then concat the placed
  // frames. Without the source size there is no exact box, so per-scene
  // framing falls back to the doc's.
  const perScene =
    !!opts.sourceSize &&
    plan.inputs.some((input) => JSON.stringify(input.video) !== JSON.stringify(plan.inputs[0].video));
  const framesOf = (i: number) =>
    plan.segments.filter((s) => s.inputIndex === i).reduce((n, s) => n + s.frameEnd - s.frameStart, 0);

  plan.inputs.forEach((input, i) => {
    const predicate = framePredicate(
      plan.segments.filter((s) => s.inputIndex === i),
    );
    const decoded = `[${i}:v]fps=${fps}:start_time=0,select='${predicate}',setpts=N/${fps}/TB`;
    if (perScene) {
      chains.push(`${decoded}[vr${i}]`);
      placeExact(chains, `vr${i}`, `v${i}`, `${i}`, resolveVideoBox(plan.canvas, input.video, opts.sourceSize!), input.video.fit, { W, H, fps, bg, frames: framesOf(i) });
    } else {
      chains.push(`${decoded}[v${i}]`);
    }
    chains.push(
      `[${i}:a]aresample=${AUDIO_SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,asetnsamples=n=${samplesPerFrame}:p=0,aselect='${predicate}',asetpts=N/SR/TB[a${i}]`,
    );
  });

  const n = plan.inputs.length;
  if (n > 1) {
    const pads = plan.inputs.map((_x, i) => `[v${i}][a${i}]`).join("");
    chains.push(`${pads}concat=n=${n}:v=1:a=1[vcat][aout]`);
  } else {
    chains.push(`[v0]null[vcat]`);
    chains.push(`[a0]anull[aout]`);
  }

  // Image layers sit between the placed video and the text: each is one
  // extra still input, scaled to its width (height follows the picture),
  // faded by its opacity, and overlaid at its anchor. `overlay` repeats a
  // still's single frame for the whole clip (its default eof_action), so no
  // looping is needed. Then the ASS burn-in, last, so text is always on top.
  const images = plan.imageLayers.slice(0, opts.imageCount ?? plan.imageLayers.length);
  const finish = (placed: string): void => {
    let cur = placed;
    images.forEach((img, i) => {
      const input = plan.inputs.length + i;
      const w = Math.max(2, Math.round((img.widthPct / 100) * W));
      const cx = Math.round((img.xPct / 100) * W);
      const cy = Math.round((img.yPct / 100) * H);
      const y = img.anchor === "top" ? `${cy}` : img.anchor === "center" ? `${cy}-overlay_h/2` : `${cy}-overlay_h`;
      const fade = img.opacity < 1 ? `,colorchannelmixer=aa=${img.opacity.toFixed(3)}` : "";
      chains.push(`[${input}:v]format=rgba,scale=${w}:-1:flags=lanczos${fade}[img${i}]`);
      // A scene's logo shows only while that scene plays.
      const win = img.sectionId ? (sectionOutWindow(plan, img.sectionId) ?? { startSec: 0, endSec: 0 }) : null;
      const enable = win ? `:enable='between(t,${win.startSec.toFixed(3)},${win.endSec.toFixed(3)})'` : "";
      chains.push(`[${cur}][img${i}]overlay=x=${cx}-overlay_w/2:y=${y}${enable}[vi${i}]`);
      cur = `vi${i}`;
    });
    const burnIn = opts.assPath
      ? `,ass=filename=${quote(opts.assPath)}:fontsdir=${quote(opts.fontsDir)}`
      : "";
    chains.push(`[${cur}]null${burnIn},format=yuv420p[vout]`);
  };

  if (perScene) {
    finish("vcat");
    return chains.join(";\n");
  }

  const video = plan.inputs[0]?.video ?? plan.video;
  if (!opts.sourceSize) {
    // Dimension-free fallback (source couldn't be probed): ffmpeg works the
    // fit out itself from the input aspect `a`. Cannot inset, zoom or round
    // the video — all need the exact box — so those settings are ignored.
    const canvasAspect = (W / H).toFixed(6);
    const place =
      video.fit === "contain"
        ? `scale=w='if(gt(a,${canvasAspect}),${W},-2)':h='if(gt(a,${canvasAspect}),-2,${H})':flags=lanczos,pad=${W}:${H}:'(ow-iw)/2':'max(0,min(oh-ih,oh*${video.yPct}/100-ih/2))':color=${bg}`
        : `scale=w='if(gt(a,${canvasAspect}),-2,${W})':h='if(gt(a,${canvasAspect}),${H},-2)':flags=lanczos,crop=${W}:${H}:'(iw-${W})*${video.panXPct}/100':'(ih-${H})/2'`;
    chains.push(`[vcat]${place},setsar=1[vplaced]`);
    finish("vplaced");
    return chains.join(";\n");
  }

  // Exact placement from the same geometry the preview uses (video-box.ts).
  placeExact(chains, "vcat", "vplaced", "", resolveVideoBox(plan.canvas, video, opts.sourceSize), video.fit, { W, H, fps, bg, frames: plan.totalFrames });
  finish("vplaced");

  return chains.join(";\n");
}

/**
 * Put one stream of source frames onto a W×H canvas at `box`. `tag` keeps
 * helper labels unique when this runs once per scene; `frames` bounds the
 * generated background / mask streams to that stream's length.
 */
function placeExact(
  chains: string[],
  input: string,
  output: string,
  tag: string,
  box: VideoBox,
  fit: "contain" | "cover",
  c: { W: number; H: number; fps: number; bg: string; frames: number },
): void {
  const { W, H, fps, bg, frames } = c;
  const scaled = `scale=${box.width}:${box.height}:flags=lanczos,setsar=1`;
  if (fit === "cover") {
    // Cover always covers the canvas, so a crop is the whole placement.
    chains.push(`[${input}]${scaled},crop=${W}:${H}:${-box.x}:${-box.y}[${output}]`);
  } else if (boxOverflows({ width: W, height: H }, box)) {
    // Zoomed past an edge: overlay onto the background, which crops
    // whatever falls off the canvas (overlay takes negative offsets).
    chains.push(`color=c=${bg}:s=${W}x${H}:r=${fps},trim=end_frame=${frames}[bg${tag}]`);
    chains.push(`[${input}]${scaled}[vz${tag}]`);
    chains.push(`[bg${tag}][vz${tag}]overlay=x=${box.x}:y=${box.y}:shortest=1,setsar=1[${output}]`);
  } else if (box.radius === 0) {
    chains.push(`[${input}]${scaled},pad=${W}:${H}:${box.x}:${box.y}:color=${bg}[${output}]`);
  } else {
    // Rounded corners = an alpha mask. The mask is a rounded-rect distance
    // field evaluated by `geq` for ONE frame, then looped forever — running
    // geq per video frame would be ~100× slower than the encode itself.
    // `+0.5`/`clip` gives a 1px anti-aliased edge instead of a staircase.
    const R = box.radius;
    const mask =
      `color=c=black:s=${box.width}x${box.height}:r=${fps},trim=end_frame=1,format=gray,` +
      `geq=lum='255*clip(${R}+0.5-hypot(max(max(${R}-X-0.5,0),X+0.5-(W-${R})),max(max(${R}-Y-0.5,0),Y+0.5-(H-${R}))),0,1)',` +
      // Bounded to the stream's exact frame count: an unbounded looped mask
      // makes alphamerge (and so the whole encode) run forever.
      `loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB,trim=end_frame=${frames}[mask${tag}]`;
    chains.push(mask);
    chains.push(`[${input}]${scaled},format=yuv420p[vs${tag}]`);
    chains.push(`[vs${tag}][mask${tag}]alphamerge[vr${tag}]`);
    chains.push(
      `color=c=${bg}:s=${W}x${H}:r=${fps},trim=end_frame=${frames}[bg${tag}]`,
    );
    chains.push(
      `[bg${tag}][vr${tag}]overlay=x=${box.x}:y=${box.y}:shortest=1:format=yuv420,setsar=1[${output}]`,
    );
  }
}

export function buildRenderArgs(args: {
  plan: RenderPlan;
  /** Local path or (presigned) https URL of the source media. */
  input: string;
  /** Local files for `plan.imageLayers`, same order. Added as inputs after
   *  the video inputs — `buildFilterGraph` refers to them by that index. */
  images?: string[];
  filterScriptPath: string;
  outputPath: string;
}): string[] {
  const isHttp = /^https?:\/\//i.test(args.input);
  const argv: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-y",
  ];
  for (const input of args.plan.inputs) {
    // -ss/-t BEFORE -i = input seek: decode starts at the section, so a clip
    // an hour into a podcast doesn't decode the hour before it. Over https
    // this is a ranged read — the source is never downloaded whole.
    if (isHttp) {
      argv.push(
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
      );
    }
    argv.push(
      "-threads",
      String(DECODER_THREADS),
      "-ss",
      input.seekSec.toFixed(3),
      "-t",
      input.readDurationSec.toFixed(3),
      "-i",
      args.input,
    );
  }
  for (const image of args.images ?? []) argv.push("-i", image);
  argv.push(
    "-filter_complex_threads",
    String(FILTER_THREADS),
    "-filter_complex_script",
    args.filterScriptPath,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-r",
    String(args.plan.canvas.fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    String(ENCODER_THREADS),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-movflags",
    "+faststart",
    args.outputPath,
  );
  return argv;
}

/** Parse one chunk of `-progress pipe:1` output → seconds rendered so far. */
export function parseProgressSeconds(chunk: string): number | null {
  let latest: number | null = null;
  for (const line of chunk.split("\n")) {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
    // Both keys are microseconds (ffmpeg's `out_time_ms` is misnamed).
    if (m) latest = Number(m[1]) / 1_000_000;
  }
  return latest;
}
