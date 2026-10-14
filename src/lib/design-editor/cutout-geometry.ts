/** Pure helpers for background-removed pictures (cutouts), shared by the
 *  browser cutout (cutout-client.ts) and the template fill. */

/** The tight box around the opaque pixels of an alpha mask (row-major,
 *  one byte per pixel), grown by `padPx` and clamped to the picture.
 *  null when nothing is opaque. */
export function alphaBounds(alpha: Uint8Array | Uint8ClampedArray, width: number, height: number, threshold = 16, padPx = 0): { x: number; y: number; w: number; h: number } | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const x0 = Math.max(0, minX - padPx);
  const y0 = Math.max(0, minY - padPx);
  const x1 = Math.min(width - 1, maxX + padPx);
  const y1 = Math.min(height - 1, maxY + padPx);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Where a cutout goes in a template's cutout box: as tall as the box at the
 * picture's own aspect (the person fills the slide's height), narrowed to
 * the box's width when they are wider than that; bottom-aligned (a person
 * cut off at the frame's bottom edge should stand on the slide's bottom
 * edge, not float) and centred horizontally.
 */
export function fitCutoutBox(box: { x: number; y: number; w: number; h: number }, size: { width: number; height: number } | null): { x: number; y: number; w: number; h: number } {
  if (!size || size.width <= 0 || size.height <= 0) return box;
  let h = box.h;
  let w = Math.round((h * size.width) / size.height);
  if (w > box.w) {
    w = box.w;
    h = Math.round((w * size.height) / size.width);
  }
  return { x: Math.round(box.x + (box.w - w) / 2), y: box.y + box.h - h, w, h };
}
