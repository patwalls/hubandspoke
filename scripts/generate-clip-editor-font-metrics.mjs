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
  "montserrat-semibold": "Montserrat-SemiBold.ttf",
  "montserrat-medium": "Montserrat-Medium.ttf",
  "inter-bold": "Inter-Bold.ttf",
  "inter-semibold": "Inter-SemiBold.ttf",
  "inter-regular": "Inter-Regular.ttf",
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

// The emoji fallback (not in the picker — layout.ts and ass.ts switch to it
// for emoji runs; see fonts.ts → EMOJI_FONT). Only emoji ranges are tabled.
const EMOJI_FONT = { id: "noto-emoji", file: "NotoEmoji-Regular.ttf" };
const EMOJI_RANGES = [
  [0xa9, 0xa9], [0xae, 0xae], [0x203c, 0x203c], [0x2049, 0x2049], [0x2122, 0x2122], [0x2139, 0x2139],
  [0x2194, 0x21aa], [0x231a, 0x23ff], [0x24c2, 0x24c2], [0x25aa, 0x25fe], [0x2600, 0x27bf],
  [0x2934, 0x2935], [0x2b05, 0x2b55], [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3299],
  [0x1f000, 0x1f2ff], [0x1f300, 0x1faff],
];

const out = {};
for (const [id, file, ranges] of [...Object.entries(FONTS).map(([id, file]) => [id, file, RANGES]), [EMOJI_FONT.id, EMOJI_FONT.file, EMOJI_RANGES]]) {
  const buf = readFileSync(path.join(root, "public/fonts/clip-editor", file));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const upm = font.unitsPerEm;
  const os2 = font.tables.os2;
  const hhea = font.tables.hhea;
  const advances = {};
  for (const [lo, hi] of ranges) {
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
    // Fallback advance for characters outside the table (CJK…). For the
    // emoji font: its typical glyph width, used for emoji it doesn't table
    // (ZWJ sequences resolve to a ligature about that wide).
    defaultAdvanceEm:
      id === EMOJI_FONT.id
        ? Math.round((Object.values(advances).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(advances).length)) * 10000) / 10000
        : 1,
    advances,
  };
}

const dest = path.join(root, "src/lib/clip-editor/font-metrics.generated.json");
writeFileSync(dest, JSON.stringify(out) + "\n");
console.log(`wrote ${dest}:`, Object.entries(out).map(([k, v]) => `${k}=${Object.keys(v.advances).length} glyphs`).join(", "));
