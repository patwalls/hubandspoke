/**
 * Deterministic text layout shared by the browser preview and the export.
 *
 * Why we don't let the renderers wrap text themselves: CSS and libass break
 * lines differently, and libass has no line-height control at all (its line
 * box is the font's full win-metric height, ~1.56em for Montserrat). If each
 * renderer wrapped on its own, a hook that previews on two tight lines could
 * export on three loose ones. So layout happens ONCE, here: we choose the
 * line breaks and the baseline of every line in canvas pixels, and both
 * renderers just draw single unwrapped lines where they are told.
 *
 * Widths come from a static advance-width table without kerning. That only
 * affects WHERE a break falls (by a percent or two of line width), never
 * whether the two renderers agree — they both draw the same pre-broken lines,
 * centered on the same x.
 */
import type { LayerAnchor, TextStyle } from "./doc";
import { FONTS, measureTextEm } from "./fonts";

/** Line pitch in em. Tight, like a social hook. */
export const LINE_HEIGHT_EM = 1.18;

export interface LaidOutWord {
  text: string;
  /** Caller-defined id carried through layout (caption word index). */
  ref: number;
  /** Force a new line before this word (an Enter typed in the hook). */
  hardBreakBefore?: boolean;
}

export interface LaidOutLine {
  words: LaidOutWord[];
  text: string;
  /** Top of the line box in canvas px (what CSS positions by). */
  topY: number;
  /** Baseline Y in canvas px (what libass positions by). */
  baselineY: number;
  widthPx: number;
}

export interface TextBlockLayout {
  fontSizePx: number;
  /** Line box height in canvas px — CSS `line-height`. */
  linePitchPx: number;
  /** Horizontal center in canvas px. */
  centerX: number;
  lines: LaidOutLine[];
  /** Bounding box of the block in canvas px (for hit-testing / drag). */
  top: number;
  bottom: number;
  widthPx: number;
}

function greedyBreak(
  widths: number[],
  spaceWidth: number,
  maxWidth: number,
  hardBreaks: boolean[],
): number[][] {
  const lines: number[][] = [];
  let current: number[] = [];
  let currentWidth = 0;
  widths.forEach((w, i) => {
    const next = current.length === 0 ? w : currentWidth + spaceWidth + w;
    if (current.length > 0 && (next > maxWidth || hardBreaks[i])) {
      lines.push(current);
      current = [i];
      currentWidth = w;
    } else {
      current.push(i);
      currentWidth = next;
    }
  });
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Break into the FEWEST lines that fit, then balance them: find the narrowest
 * width that still yields that many lines. Avoids the orphan ("…one lonely
 * word on line two") that plain greedy wrapping produces on hooks.
 */
function balancedBreak(
  widths: number[],
  spaceWidth: number,
  maxWidth: number,
  hardBreaks: boolean[],
): number[][] {
  const greedy = greedyBreak(widths, spaceWidth, maxWidth, hardBreaks);
  if (greedy.length <= 1) return greedy;
  const target = greedy.length;
  let lo = Math.max(...widths);
  let hi = maxWidth;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (greedyBreak(widths, spaceWidth, mid, hardBreaks).length <= target) hi = mid;
    else lo = mid;
  }
  return greedyBreak(widths, spaceWidth, hi, hardBreaks);
}

export function layoutTextBlock(args: {
  words: LaidOutWord[];
  style: TextStyle;
  canvas: { width: number; height: number };
  xPct: number;
  yPct: number;
  anchor: LayerAnchor;
  widthPct: number;
  /** Balance line widths (hooks) or fill greedily (captions). */
  balance: boolean;
}): TextBlockLayout {
  const font = FONTS[args.style.fontId];
  const fontSizePx = (args.style.sizePct / 100) * args.canvas.height;
  const maxWidth = (args.widthPct / 100) * args.canvas.width;
  const centerX = (args.xPct / 100) * args.canvas.width;
  const anchorY = (args.yPct / 100) * args.canvas.height;

  const display = (t: string) => (args.style.uppercase ? t.toUpperCase() : t);
  const words = args.words.map((w) => ({ ...w, text: display(w.text) }));
  const widths = words.map((w) => measureTextEm(font, w.text) * fontSizePx);
  const spaceWidth = measureTextEm(font, " ") * fontSizePx;

  const breaks = (args.balance ? balancedBreak : greedyBreak)(
    widths,
    spaceWidth,
    maxWidth,
    words.map((w) => w.hardBreakBefore === true),
  );

  const pitch = LINE_HEIGHT_EM * fontSizePx;
  const blockHeight = breaks.length * pitch;
  const top =
    args.anchor === "top"
      ? anchorY
      : args.anchor === "bottom"
        ? anchorY - blockHeight
        : anchorY - blockHeight / 2;

  // Baseline sits where CSS would put it in a line box of height `pitch`:
  // half-leading + the font's (hhea) ascent.
  const { hheaAscentEm, hheaDescentEm } = font.metrics;
  const baselineInLine =
    (pitch - (hheaAscentEm + hheaDescentEm) * fontSizePx) / 2 +
    hheaAscentEm * fontSizePx;

  const lines: LaidOutLine[] = breaks.map((idxs, li) => {
    const lineWords = idxs.map((i) => words[i]);
    const widthPx =
      idxs.reduce((n, i) => n + widths[i], 0) +
      spaceWidth * Math.max(0, idxs.length - 1);
    return {
      words: lineWords,
      text: lineWords.map((w) => w.text).join(" "),
      topY: top + li * pitch,
      baselineY: top + li * pitch + baselineInLine,
      widthPx,
    };
  });

  return {
    fontSizePx,
    linePitchPx: pitch,
    centerX,
    lines,
    top,
    bottom: top + blockHeight,
    widthPx: lines.reduce((m, l) => Math.max(m, l.widthPx), 0),
  };
}

/** Split free text into layout words (hook text: refs are just positions). */
export function textToLayoutWords(text: string): LaidOutWord[] {
  const out: LaidOutWord[] = [];
  text.split(/\r?\n/).forEach((line, li) => {
    line
      .split(/\s+/)
      .filter(Boolean)
      .forEach((t, wi) => {
        out.push({
          text: t,
          ref: out.length,
          ...(li > 0 && wi === 0 && out.length > 0
            ? { hardBreakBefore: true }
            : {}),
        });
      });
  });
  return out;
}

/**
 * Largest font size (in `sizePct`, stepping down from the layer's own) at
 * which a text block fits inside `maxHeightPct` of the canvas. AI-written
 * hooks run from five words to a full paragraph; the default doc uses this so
 * a long one starts out readable-and-on-canvas instead of spilling off the
 * top. It only picks the STARTING size — the editor can still resize freely.
 */
export function fitTextSizePct(args: {
  text: string;
  style: TextStyle;
  canvas: { width: number; height: number };
  widthPct: number;
  maxHeightPct: number;
  minSizePct?: number;
}): number {
  const min = args.minSizePct ?? 2;
  let sizePct = args.style.sizePct;
  while (sizePct > min) {
    const layout = layoutTextBlock({
      words: textToLayoutWords(args.text),
      style: { ...args.style, sizePct },
      canvas: args.canvas,
      xPct: 50,
      yPct: 0,
      anchor: "top",
      widthPct: args.widthPct,
      balance: true,
    });
    if (layout.bottom - layout.top <= (args.maxHeightPct / 100) * args.canvas.height) break;
    sizePct = Math.round((sizePct - 0.1) * 10) / 10;
  }
  return Math.max(min, sizePct);
}
