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

/**
 * Order here is the order of the font picker. `assFamily` must be a family
 * name libass can resolve from the file's name table — for a weight that
 * ships as its own family ("Poppins ExtraBold") use that name with
 * assBold=false; for a true Bold of a base family use the base name with
 * assBold=true. Verify a new font with the calibration check in
 * `scripts/clip-editor-font-calibration.ts` (cap height + baseline measured
 * on a real libass render).
 */
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
  "poppins-extrabold": {
    id: "poppins-extrabold",
    label: "Poppins ExtraBold",
    cssFamily: "ClipEditor Poppins ExtraBold",
    cssWeight: 800,
    assFamily: "Poppins ExtraBold",
    assBold: false,
    metrics: metrics["poppins-extrabold"],
  },
  "poppins-semibold": {
    id: "poppins-semibold",
    label: "Poppins SemiBold",
    cssFamily: "ClipEditor Poppins SemiBold",
    cssWeight: 600,
    assFamily: "Poppins SemiBold",
    assBold: false,
    metrics: metrics["poppins-semibold"],
  },
  "archivo-black": {
    id: "archivo-black",
    label: "Archivo Black",
    cssFamily: "ClipEditor Archivo Black",
    cssWeight: 400,
    assFamily: "Archivo Black",
    assBold: false,
    metrics: metrics["archivo-black"],
  },
  "anton": {
    id: "anton",
    label: "Anton",
    cssFamily: "ClipEditor Anton",
    cssWeight: 400,
    assFamily: "Anton",
    assBold: false,
    metrics: metrics["anton"],
  },
  "bebas-neue": {
    id: "bebas-neue",
    label: "Bebas Neue",
    cssFamily: "ClipEditor Bebas Neue",
    cssWeight: 400,
    assFamily: "Bebas Neue",
    assBold: false,
    metrics: metrics["bebas-neue"],
  },
  "bangers": {
    id: "bangers",
    label: "Bangers",
    cssFamily: "ClipEditor Bangers",
    cssWeight: 400,
    assFamily: "Bangers",
    assBold: false,
    metrics: metrics["bangers"],
  },
  "dm-serif-display": {
    id: "dm-serif-display",
    label: "DM Serif Display",
    cssFamily: "ClipEditor DM Serif Display",
    cssWeight: 400,
    assFamily: "DM Serif Display",
    assBold: false,
    metrics: metrics["dm-serif-display"],
  },
  "permanent-marker": {
    id: "permanent-marker",
    label: "Permanent Marker",
    cssFamily: "ClipEditor Permanent Marker",
    cssWeight: 400,
    assFamily: "Permanent Marker",
    assBold: false,
    metrics: metrics["permanent-marker"],
  },
};

export const FONT_PUBLIC_DIR = "/fonts/clip-editor";

/** @font-face rules for every registered font (injected once by the stage). */
export function fontFaceCss(): string {
  return Object.values(FONTS)
    .map(
      (f) =>
        // ascent/descent/line-gap overrides pin the metrics the browser lays
        // text out with. Without them Chrome uses hhea on macOS but OS/2 win
        // metrics on Windows — and for a font like Bangers those differ by
        // half an em, which would move the preview's baseline (but not the
        // export's) depending on who opened the editor.
        `@font-face{font-family:"${f.cssFamily}";src:url("${FONT_PUBLIC_DIR}/${f.metrics.file}") format("truetype");font-weight:${f.cssWeight};font-style:normal;font-display:block;ascent-override:${(f.metrics.hheaAscentEm * 100).toFixed(2)}%;descent-override:${(f.metrics.hheaDescentEm * 100).toFixed(2)}%;line-gap-override:0%;}`,
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
