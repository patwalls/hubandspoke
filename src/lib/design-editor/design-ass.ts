/**
 * Captions element → ASS script for ffmpeg's `ass` filter. Same approach as
 * the clip editor's ass.ts: every cue is pre-broken into lines by the shared
 * layout engine and placed with an explicit \pos, so libass only rasterizes
 * glyphs. Times are in CLIP seconds (the rendered mp4's own timeline).
 */
import { assEscape, assTime } from "@/lib/clip-editor/ass";
import { FONTS, assFontSizeFactor } from "@/lib/clip-editor/fonts";
import type { DesignCaptionsElement } from "./doc";
import { layoutCaptionCue, type DesignCaptionCue } from "./captions";

function assColor(hex: string, alpha = 1): string {
  const a = Math.round((1 - alpha) * 255).toString(16).padStart(2, "0");
  return `&H${a}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
}

export function buildCaptionsAss(
  el: DesignCaptionsElement,
  cues: DesignCaptionCue[],
  canvas: { width: number; height: number },
): string {
  const font = FONTS[el.style.fontId];
  const events: string[] = [];
  let maxFontSize = el.style.sizePx;
  const laid = cues.map((cue) => ({ cue, layout: layoutCaptionCue(el, cue.text) }));
  // One ASS style per distinct fitted size (autoFit can shrink long cues).
  const sizes = [...new Set(laid.map((l) => Math.round(l.layout.fontSizePx * 100) / 100))];
  const styleName = (size: number) => `Cap${sizes.indexOf(size)}`;
  const styles = sizes.map((size) => {
    maxFontSize = Math.max(maxFontSize, size);
    const shadow = el.style.shadow;
    return [
      `Style: ${styleName(size)}`, font.assFamily, Math.round(size * assFontSizeFactor(font) * 100) / 100,
      assColor(el.style.color), assColor(el.style.color),
      shadow ? assColor(shadow.color, shadow.alpha) : "&H00000000", shadow ? assColor(shadow.color, shadow.alpha) : "&H00000000",
      font.assBold ? -1 : 0, 0, 0, 0, 100, 100, 0, 0, 1,
      shadow ? Math.round(Math.min(shadow.blur / 4, 6) * 100) / 100 : 0, // outline stands in for blur
      shadow ? Math.round(Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) * 100) / 100 : 0,
      8, 0, 0, 0, 1,
    ].join(",");
  });
  const { hheaAscentEm, hheaDescentEm } = font.metrics;
  for (const { cue, layout } of laid) {
    const size = Math.round(layout.fontSizePx * 100) / 100;
    // Baseline where CSS puts it in a line box of `linePitchPx`; libass with
    // \an8 anchors the TOP of its own line box, winAscent above the baseline.
    const baselineInLine = (layout.linePitchPx - (hheaAscentEm + hheaDescentEm) * layout.fontSizePx) / 2 + hheaAscentEm * layout.fontSizePx;
    for (const line of layout.lines) {
      const x = line.x + line.widthPx / 2;
      const y = line.y + baselineInLine - font.metrics.winAscentEm * layout.fontSizePx;
      const text = line.words.map((w) => assEscape(el.style.uppercase ? w.text.toUpperCase() : w.text)).join(" ");
      events.push(`Dialogue: 5,${assTime(cue.startSec)},${assTime(cue.endSec)},${styleName(size)},,0,0,0,,{\\an8\\q2\\pos(${x.toFixed(1)},${y.toFixed(1)})}${text}`);
    }
  }
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${canvas.width}`, `PlayResY: ${canvas.height}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles, "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
  ].join("\n") + "\n";
}
