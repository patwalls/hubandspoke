/**
 * Scene → ASS subtitle script, burned in by ffmpeg's `ass` filter (libass).
 *
 * Every event is ONE pre-broken line placed with an explicit \pos and \q2
 * (no wrapping), top-center anchored (\an8). libass is used purely as a
 * glyph rasterizer — all layout already happened in layout.ts.
 */
import type { TextStyle } from "./doc";
import { FONTS, assFontSizeFactor } from "./fonts";
import type { LaidOutLine, TextBlockLayout } from "./layout";
import type { RenderPlan } from "./plan";
import type { Scene } from "./scene";

/** "#RRGGBB" → ASS &HAABBGGRR (alpha 00 = opaque). */
function assColor(hex: string): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function assInlineColor(hex: string): string {
  return `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
}

/** Seconds → H:MM:SS.cc (ASS is centisecond-resolution). */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p2 = (n: number) => n.toString().padStart(2, "0");
  return `${h}:${p2(m)}:${p2(s)}.${p2(c)}`;
}

/** Neutralize characters libass would read as override tags or escapes. */
export function assEscape(text: string): string {
  return text
    .replace(/\\/g, "\\⁠") // break "\N", "\h" etc. with a word joiner
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝")
    .replace(/\r?\n/g, " ");
}

function styleLine(name: string, style: TextStyle, fontSizePx: number): string {
  const font = FONTS[style.fontId];
  const assSize = Math.round(fontSizePx * assFontSizeFactor(font) * 100) / 100;
  const outline =
    Math.round(((style.outlinePct / 100) * fontSizePx) * 100) / 100;
  return [
    `Style: ${name}`,
    font.assFamily,
    assSize,
    assColor(style.color),
    assColor(style.color),
    assColor(style.outlineColor),
    "&H00000000",
    font.assBold ? -1 : 0,
    0, // italic
    0, // underline
    0, // strikeout
    100, // scaleX
    100, // scaleY
    0, // spacing
    0, // angle
    1, // border style: outline + shadow
    outline,
    0, // shadow
    8, // alignment: top-center (every event overrides position anyway)
    0,
    0,
    0,
    1,
  ].join(",");
}

/** \pos Y for a line: libass puts the TOP of its line box at \pos with \an8,
 *  and the baseline `winAscent` below that. */
function posY(style: TextStyle, layout: TextBlockLayout, line: LaidOutLine) {
  const font = FONTS[style.fontId];
  return line.baselineY - font.metrics.winAscentEm * layout.fontSizePx;
}

/** libass anchors: 7 = top-left, 8 = top-centre, 9 = top-right. The line's
 *  left/centre/right edge (per its alignment) goes at \pos. */
function event(
  start: number,
  end: number,
  styleName: string,
  x: number,
  y: number,
  text: string,
  layer: number,
  align: TextStyle["align"] = "center",
): string {
  const an = align === "left" ? 7 : align === "right" ? 9 : 8;
  const pos = `{\\an${an}\\q2\\pos(${x.toFixed(1)},${y.toFixed(1)})}`;
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${pos}${text}`;
}

function lineAnchorX(line: LaidOutLine, align: TextStyle["align"]): number {
  return align === "left" ? line.x : align === "right" ? line.x + line.widthPx : line.x + line.widthPx / 2;
}

/** &HAA — ASS alpha, 00 = opaque. */
function assAlpha(alpha: number): string {
  return `&H${Math.round((1 - alpha) * 255).toString(16).padStart(2, "0").toUpperCase()}&`;
}

/**
 * The rounded box behind a line as an ASS vector drawing: a rectangle path
 * with bezier corners, filled with the box colour. Same rectangle the
 * stage draws (stage.tsx → LineBox). Drawn on a layer under the text.
 */
function boxEvent(start: number, end: number, styleName: string, style: TextStyle, layout: TextBlockLayout, line: LaidOutLine, layer: number): string | null {
  if (!style.box) return null;
  const pad = (style.box.padPct / 100) * layout.fontSizePx;
  const w = line.widthPx + pad * 2;
  const h = layout.linePitchPx;
  const r = Math.min((style.box.radiusPct / 100) * layout.fontSizePx, w / 2, h / 2);
  const f = (n: number) => n.toFixed(1);
  // Cubic beziers with both control points on the corner ≈ a quarter circle.
  const path =
    `m ${f(r)} 0 l ${f(w - r)} 0 b ${f(w)} 0 ${f(w)} 0 ${f(w)} ${f(r)} ` +
    `l ${f(w)} ${f(h - r)} b ${f(w)} ${f(h)} ${f(w)} ${f(h)} ${f(w - r)} ${f(h)} ` +
    `l ${f(r)} ${f(h)} b 0 ${f(h)} 0 ${f(h)} 0 ${f(h - r)} ` +
    `l 0 ${f(r)} b 0 0 0 0 ${f(r)} 0`;
  const tags = `{\\an7\\pos(${f(line.x - pad)},${f(line.topY)})\\bord0\\shad0\\c${assInlineColor(style.box.color)}\\1a${assAlpha(style.box.alpha)}\\p1}`;
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${tags}${path}{\\p0}`;
}

/**
 * A soft shadow as a blurred, offset copy of the line in the shadow colour,
 * under the text (libass can't blur the built-in shadow without blurring
 * the glyph). The copy keeps the outline's shape so the silhouette matches.
 */
function shadowEvent(start: number, end: number, styleName: string, style: TextStyle, layout: TextBlockLayout, line: LaidOutLine, text: string, x: number, y: number, layer: number): string | null {
  if (!style.shadow) return null;
  const s = style.shadow;
  const dx = (s.xPct / 100) * layout.fontSizePx;
  const dy = (s.yPct / 100) * layout.fontSizePx;
  const blur = ((s.blurPct / 100) * layout.fontSizePx) / 2; // CSS blur radius ≈ 2× libass \blur
  const an = style.align === "left" ? 7 : style.align === "right" ? 9 : 8;
  const tags = `{\\an${an}\\q2\\pos(${(x + dx).toFixed(1)},${(y + dy).toFixed(1)})\\c${assInlineColor(s.color)}\\3c${assInlineColor(s.color)}\\1a${assAlpha(s.alpha)}\\3a${assAlpha(s.alpha)}\\shad0\\blur${blur.toFixed(2)}}`;
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},${styleName},,0,0,0,,${tags}${text}`;
}

export function buildAssScript(plan: RenderPlan, scene: Scene): string {
  const styles: string[] = [];
  const events: string[] = [];

  scene.textBlocks.forEach((block, bi) => {
    const name = `Text${bi}`;
    styles.push(styleLine(name, block.layer.style, block.layout.fontSizePx));
    for (const line of block.layout.lines) {
      const bx = boxEvent(0, plan.durationSec + 1, name, block.layer.style, block.layout, line, 8 + bi);
      if (bx) events.push(bx);
      const sh = shadowEvent(0, plan.durationSec + 1, name, block.layer.style, block.layout, line, assEscape(line.text), lineAnchorX(line, block.layer.style.align), posY(block.layer.style, block.layout, line), 9 + bi);
      if (sh) events.push(sh);
      events.push(
        event(
          0,
          plan.durationSec + 1,
          name,
          lineAnchorX(line, block.layer.style.align),
          posY(block.layer.style, block.layout, line),
          assEscape(line.text),
          10 + bi,
          block.layer.style.align,
        ),
      );
    }
  });

  if (scene.captions) {
    const { layer, cues } = scene.captions;
    const fontSizePx = (layer.style.sizePct / 100) * plan.canvas.height;
    styles.push(styleLine("Captions", layer.style, fontSizePx));
    for (const { cue, layout } of cues) {
      // One set of events per highlighted word; without a highlight colour
      // the whole cue is a single interval.
      const intervals = layer.highlightColor
        ? cue.words.map((w, i) => ({
            start: w.outStartSec,
            end: w.outEndSec,
            active: i,
          }))
        : [{ start: cue.outStartSec, end: cue.outEndSec, active: -1 }];
      for (const iv of intervals) {
        if (iv.end - iv.start < 0.005) continue;
        for (const line of layout.lines) {
          const bx = boxEvent(iv.start, iv.end, "Captions", layer.style, layout, line, 3);
          if (bx) events.push(bx);
          const sh = shadowEvent(iv.start, iv.end, "Captions", layer.style, layout, line, line.words.map((w) => assEscape(w.text)).join(" "), lineAnchorX(line, layer.style.align), posY(layer.style, layout, line), 4);
          if (sh) events.push(sh);
          const text = line.words
            .map((w) =>
              w.ref === iv.active && layer.highlightColor
                ? `{\\c${assInlineColor(layer.highlightColor)}}${assEscape(w.text)}{\\c${assInlineColor(layer.style.color)}}`
                : assEscape(w.text),
            )
            .join(" ");
          events.push(
            event(
              iv.start,
              iv.end,
              "Captions",
              lineAnchorX(line, layer.style.align),
              posY(layer.style, layout, line),
              text,
              5,
              layer.style.align,
            ),
          );
        }
      }
    }
  }

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${plan.canvas.width}`,
    `PlayResY: ${plan.canvas.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
