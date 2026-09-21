/**
 * Text layout for design elements — explicit lines in canvas px, computed
 * once and drawn identically by the stage (DOM) and the exporter (satori).
 * Reuses the clip editor's word-based engine and font metrics.
 */
import { layoutTextBlock, type LaidOutWord } from "@/lib/clip-editor/layout";
import { LINE_HEIGHT_EM } from "@/lib/clip-editor/layout";
import type { DesignCrop, DesignSpan, DesignTextElement } from "./doc";

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
/** A word that starts a new paragraph remembers how many blank lines
 *  preceded it — they become a paragraph gap in the layout. */
type ParaWord = LaidOutWord & { color: string | null; blankBefore?: number };

function spanWords(spans: DesignSpan[], uppercase: boolean): ParaWord[] {
  const out: ParaWord[] = [];
  let blank = 0;
  spans.forEach((span, si) => {
    span.text.split(/\r?\n/).forEach((line, li) => {
      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        if (li > 0) blank += 1;
        return;
      }
      tokens.forEach((t, wi) => {
        const first = wi === 0 && out.length > 0 && (li > 0 || blank > 0);
        out.push({
          text: uppercase ? t.toUpperCase() : t,
          ref: si,
          color: span.color ?? null,
          ...(first ? { hardBreakBefore: true } : {}),
          ...(first && blank > 0 ? { blankBefore: blank } : {}),
        });
        if (wi === 0) blank = 0;
      });
    });
  });
  return out;
}

/** Vertical room a blank line takes, as a share of the line pitch. */
const PARAGRAPH_GAP = 0.65;

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
      align: "center", // the design engine aligns lines itself below
      shadow: null,
      box: null,
    },
    canvas,
    xPct: 50,
    yPct: 0,
    anchor: "top",
    widthPct: 100,
    balance: false,
  });
  // The engine's pitch is fixed (LINE_HEIGHT_EM); rescale to the element's.
  // Paragraph gaps (blank lines in the text) add to the block on top.
  const pitch = fontSizePx * el.style.lineHeight;
  const gapPx = pitch * PARAGRAPH_GAP;
  const lineGaps: number[] = [];
  {
    let wi = 0;
    for (const line of base.lines) {
      lineGaps.push((words[wi]?.blankBefore ?? 0) * gapPx);
      wi += line.words.length;
    }
  }
  const blockHeightPx = base.lines.length * pitch + lineGaps.reduce((a, b) => a + b, 0);
  const startY =
    el.style.valign === "top"
      ? el.y
      : el.style.valign === "bottom"
        ? el.y + el.h - blockHeightPx
        : el.y + (el.h - blockHeightPx) / 2;

  let wi = 0;
  let offset = 0;
  const lines: DesignLine[] = base.lines.map((line, li) => {
    offset += lineGaps[li];
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
    return { words: lineWords, x, y: startY + li * pitch + offset, widthPx: line.widthPx };
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

/**
 * Where a `cover`-fitted picture (or video) is drawn inside its box, in box
 * px: scaled so it covers the box times `crop.zoom`, then panned so the focal
 * point sits at the box centre — clamped so the box never shows a gap. The
 * stage's <img>/<video>, satori's <img> and ffmpeg's scale+crop all take
 * their numbers from here.
 */
export function coverGeometry(
  natural: { width: number; height: number },
  box: { w: number; h: number },
  crop: DesignCrop,
  fit: "cover" | "contain" = "cover",
): { left: number; top: number; width: number; height: number } {
  if (natural.width <= 0 || natural.height <= 0) return { left: 0, top: 0, width: box.w, height: box.h };
  const base = fit === "cover" ? Math.max(box.w / natural.width, box.h / natural.height) : Math.min(box.w / natural.width, box.h / natural.height);
  const scale = base * (fit === "cover" ? crop.zoom : 1);
  const width = natural.width * scale;
  const height = natural.height * scale;
  if (fit === "contain") return { left: (box.w - width) / 2, top: (box.h - height) / 2, width, height };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const left = clamp(box.w / 2 - crop.x * width, Math.min(0, box.w - width), 0);
  const top = clamp(box.h / 2 - crop.y * height, Math.min(0, box.h - height), 0);
  return { left, top, width, height };
}

/** Inverse of `coverGeometry`'s pan: the crop that puts the picture at
 *  (left, top) — how dragging inside a picture becomes a focal point. */
export function cropForOffset(
  natural: { width: number; height: number },
  box: { w: number; h: number },
  crop: DesignCrop,
  offset: { left: number; top: number },
): DesignCrop {
  const g = coverGeometry(natural, box, crop);
  const x = g.width > 0 ? (box.w / 2 - offset.left) / g.width : 0.5;
  const y = g.height > 0 ? (box.h / 2 - offset.top) / g.height : 0.5;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return { ...crop, x: clamp01(x), y: clamp01(y) };
}
