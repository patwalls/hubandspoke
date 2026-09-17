#!/usr/bin/env node
/**
 * Generate src/lib/clip-editor/font-metrics.generated.json from the TTFs in
 * public/fonts/clip-editor/.
 *
 * The clip editor does its own text layout (line breaking + baseline
 * placement) so the browser preview and the ffmpeg/libass export break lines
 * identically. That needs glyph advance widths available synchronously in
 * both the browser and the worker — hence a small committed table instead of
 * parsing fonts at runtime.
 *
 * Re-run after adding a font to FONTS below (and to src/lib/clip-editor/fonts.ts):
 *   node scripts/generate-clip-editor-font-metrics.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONTS = {
  "montserrat-extrabold": "Montserrat-ExtraBold.ttf",
  "montserrat-bold": "Montserrat-Bold.ttf",
  "poppins-extrabold": "Poppins-ExtraBold.ttf",
  "poppins-semibold": "Poppins-SemiBold.ttf",
  "archivo-black": "ArchivoBlack-Regular.ttf",
  "anton": "Anton-Regular.ttf",
  "bebas-neue": "BebasNeue-Regular.ttf",
  "bangers": "Bangers-Regular.ttf",
  "dm-serif-display": "DMSerifDisplay-Regular.ttf",
  "permanent-marker": "PermanentMarker-Regular.ttf",
};

// Latin + Latin-1/Extended-A, general punctuation, currency, arrows.
const RANGES = [
  [0x20, 0x7e],
  [0xa0, 0x17f],
  [0x2010, 0x2027],
  [0x2030, 0x203a],
  [0x20a0, 0x20bf],
  [0x2190, 0x2193],
];

const out = {};
for (const [id, file] of Object.entries(FONTS)) {
  const buf = readFileSync(path.join(root, "public/fonts/clip-editor", file));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const upm = font.unitsPerEm;
  const os2 = font.tables.os2;
  const hhea = font.tables.hhea;
  const advances = {};
  for (const [lo, hi] of RANGES) {
    for (let cp = lo; cp <= hi; cp++) {
      const glyph = font.charToGlyph(String.fromCodePoint(cp));
      if (!glyph || glyph.index === 0) continue;
      advances[cp] = Math.round((glyph.advanceWidth / upm) * 10000) / 10000;
    }
  }
  out[id] = {
    file,
    // Em-relative vertical metrics. `win*` is what libass sizes/places text
    // by; `hhea*` is what browsers use for the CSS content area.
    winAscentEm: os2.usWinAscent / upm,
    winDescentEm: os2.usWinDescent / upm,
    hheaAscentEm: hhea.ascender / upm,
    hheaDescentEm: Math.abs(hhea.descender) / upm,
    capHeightEm: (os2.sCapHeight || 700) / upm,
    // Fallback advance for characters outside the table (emoji, CJK…).
    defaultAdvanceEm: 1,
    advances,
  };
}

const dest = path.join(root, "src/lib/clip-editor/font-metrics.generated.json");
writeFileSync(dest, JSON.stringify(out) + "\n");
console.log(`wrote ${dest}:`, Object.entries(out).map(([k, v]) => `${k}=${Object.keys(v.advances).length} glyphs`).join(", "));
