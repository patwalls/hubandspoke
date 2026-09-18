/**
 * Text layout for design elements — explicit lines in canvas px, computed
 * once and drawn identically by the stage (DOM) and the exporter (satori).
 * Reuses the clip editor's word-based engine and font metrics.
 */
import { layoutTextBlock, type LaidOutWord } from "@/lib/clip-editor/layout";
import { LINE_HEIGHT_EM } from "@/lib/clip-editor/layout";
import type { DesignSpan, DesignTextElement } from "./doc";

export interface DesignLine {
  /** Each word with its colour (from its span) — drawn as one run each. */
  words: Array<{ text: string; color: string | null }>;
  /** Left edge of the line in canvas px, after alignment. */
  x: number;
  /** Top of the line box in canvas px. */
  y: number;
  widthPx: number;
}

export interface DesignTextLayout {
  fontSizePx: number;
  linePitchPx: number;
  lines: DesignLine[];
  /** Total height of all lines. */
  blockHeightPx: number;
  overflows: boolean;
}

/** Break spans into layout words, each remembering its span's colour and
 *  hard breaks (`\n`). */
function spanWords(spans: DesignSpan[], uppercase: boolean): Array<LaidOutWord & { color: string | null }> {
  const out: Array<LaidOutWord & { color: string | null }> = [];
  spans.forEach((span, si) => {
    span.text.split(/\r?\n/).forEach((line, li) => {
      line
        .split(/\s+/)
        .filter(Boolean)
        .forEach((t, wi) => {
          out.push({
            text: uppercase ? t.toUpperCase() : t,
            ref: si,
            color: span.color ?? null,
            ...(li > 0 && wi === 0 && out.length > 0 ? { hardBreakBefore: true } : {}),
          });
        });
    });
  });
  return out;
}

function layoutAt(el: DesignTextElement, fontSizePx: number): DesignTextLayout {
  const words = spanWords(el.spans, el.style.uppercase);
  // The shared engine works in canvas-% units; feed it a canvas whose height
  // makes `sizePct` equal our px, and whose width equals the box width.
  const canvas = { width: el.w, height: 100 };
  const base = layoutTextBlock({
    words: words.map((w) => ({ text: w.text, ref: w.ref, hardBreakBefore: w.hardBreakBefore })),
    style: {
      fontId: el.style.fontId,
      sizePct: fontSizePx, // height is 100 → sizePct == px
      color: el.style.color,
      outlinePct: 0,
      outlineColor: "#000000",
      uppercase: false, // already applied
    },
    canvas,
    xPct: 50,
    yPct: 0,
    anchor: "top",
    widthPct: 100,
    balance: false,
  });
  // The engine's pitch is fixed (LINE_HEIGHT_EM); rescale to the element's.
  const pitch = fontSizePx * el.style.lineHeight;
  const blockHeightPx = base.lines.length * pitch;
  const startY =
    el.style.valign === "top"
      ? el.y
      : el.style.valign === "bottom"
        ? el.y + el.h - blockHeightPx
        : el.y + (el.h - blockHeightPx) / 2;

  let wi = 0;
  const lines: DesignLine[] = base.lines.map((line, li) => {
    const lineWords = line.words.map((w) => {
      const color = words[wi]?.color ?? null;
      wi += 1;
      return { text: w.text, color };
    });
    const x =
      el.style.align === "left"
        ? el.x
        : el.style.align === "right"
          ? el.x + el.w - line.widthPx
          : el.x + (el.w - line.widthPx) / 2;
    return { words: lineWords, x, y: startY + li * pitch, widthPx: line.widthPx };
  });
  void LINE_HEIGHT_EM;
  return {
    fontSizePx,
    linePitchPx: pitch,
    lines,
    blockHeightPx,
    overflows: blockHeightPx > el.h + 0.5 || lines.some((l) => l.widthPx > el.w + 0.5),
  };
}

/** Lay out a text element; with `autoFit`, shrink until it fits its box. */
export function layoutDesignText(el: DesignTextElement): DesignTextLayout {
  let size = el.style.sizePx;
  let layout = layoutAt(el, size);
  if (!el.style.autoFit) return layout;
  while (layout.overflows && size > el.style.minSizePx) {
    size = Math.max(el.style.minSizePx, size - Math.max(1, size * 0.04));
    layout = layoutAt(el, size);
  }
  return layout;
}
