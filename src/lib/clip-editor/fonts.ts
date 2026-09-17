/**
 * Font registry for the clip editor.
 *
 * A font here must exist in three places, all driven by this file:
 *   1. the TTF in public/fonts/clip-editor/ — served to the browser via
 *      @font-face AND handed to libass via `fontsdir`, so preview and export
 *      rasterize the very same file;
 *   2. `assFamily`/`assBold` — how libass finds it (family name as written in
 *      the font's name table, NOT the file name);
 *   3. font-metrics.generated.json — advance widths + vertical metrics used
 *      by layout.ts. Regenerate with
 *      `node scripts/generate-clip-editor-font-metrics.mjs`.
 *
 * Static TTFs only: the production ffmpeg is a 2018 static build whose
 * FreeType predates usable variable-font support.
 */
import type { FontId } from "./doc";
import metricsJson from "./font-metrics.generated.json";

export interface FontMetrics {
  file: string;
  winAscentEm: number;
  winDescentEm: number;
  hheaAscentEm: number;
  hheaDescentEm: number;
  capHeightEm: number;
  defaultAdvanceEm: number;
  advances: Record<string, number>;
}

export interface FontDefinition {
  id: FontId;
  label: string;
  /** CSS font-family the @font-face is registered under. */
  cssFamily: string;
  cssWeight: number;
  assFamily: string;
  assBold: boolean;
  metrics: FontMetrics;
}

const metrics = metricsJson as Record<FontId, FontMetrics>;

export const FONTS: Record<FontId, FontDefinition> = {
  "montserrat-extrabold": {
    id: "montserrat-extrabold",
    label: "Montserrat ExtraBold",
    cssFamily: "ClipEditor Montserrat ExtraBold",
    cssWeight: 800,
    assFamily: "Montserrat ExtraBold",
    assBold: false,
    metrics: metrics["montserrat-extrabold"],
  },
  "montserrat-bold": {
    id: "montserrat-bold",
    label: "Montserrat Bold",
    cssFamily: "ClipEditor Montserrat Bold",
    cssWeight: 700,
    assFamily: "Montserrat",
    assBold: true,
    metrics: metrics["montserrat-bold"],
  },
};

export const FONT_PUBLIC_DIR = "/fonts/clip-editor";

/** @font-face rules for every registered font (injected once by the stage). */
export function fontFaceCss(): string {
  return Object.values(FONTS)
    .map(
      (f) =>
        `@font-face{font-family:"${f.cssFamily}";src:url("${FONT_PUBLIC_DIR}/${f.metrics.file}") format("truetype");font-weight:${f.cssWeight};font-style:normal;font-display:block;}`,
    )
    .join("\n");
}

/**
 * libass sizes a font so that (winAscent + winDescent) == Fontsize, whereas
 * CSS `font-size` is the em. Multiply an em size in px by this to get the ASS
 * Fontsize that rasterizes at the same glyph size. Verified against a
 * rendered calibration frame (cap height of "H") for Montserrat.
 */
export function assFontSizeFactor(font: FontDefinition): number {
  return font.metrics.winAscentEm + font.metrics.winDescentEm;
}

/** Advance width of `text` in em. No kerning — see layout.ts for why that
 *  is fine. */
export function measureTextEm(font: FontDefinition, text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    width += font.metrics.advances[String(cp)] ?? font.metrics.defaultAdvanceEm;
  }
  return width;
}
