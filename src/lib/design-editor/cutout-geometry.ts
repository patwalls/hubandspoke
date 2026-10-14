/** Pure helpers for background-removed pictures (cutouts), shared by the
 *  browser cutout (cutout-client.ts) and the template fill. */
import { DEFAULT_CROP, type DesignCrop } from "./doc";
import { coverGeometry } from "./layout";

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

/** Where the subject sat in the picture it was cut from, as 0–1 fractions
 *  of that picture's width/height (scale-free, so it holds for the preview
 *  and the full-size original alike). */
export interface CutoutBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * "Split into layers": the box, fit and crop that put a trimmed cutout
 * exactly over the person in the picture element it was cut from, so the
 * original stays underneath as the background layer and anything placed
 * between the two lands behind the person. The subject layer is clipped to
 * the original's frame the way the original was (cover + crop on the
 * visible part); when the whole subject is in frame it is a plain `contain`
 * box. A tilted picture's subject keeps the tilt and orbits the picture's
 * centre. null when the subject is entirely out of frame.
 */
export function subjectLayerGeometry(
  el: { x: number; y: number; w: number; h: number; fit: "cover" | "contain"; crop: DesignCrop; rotation?: number },
  natural: { width: number; height: number },
  bounds: CutoutBounds,
): { x: number; y: number; w: number; h: number; fit: "cover" | "contain"; crop: DesignCrop; rotation?: number } | null {
  const g = coverGeometry(natural, { w: el.w, h: el.h }, el.crop, el.fit);
  // The subject in the picture's box (unrotated, box-local px).
  const sx = g.left + bounds.x * g.width;
  const sy = g.top + bounds.y * g.height;
  const sw = bounds.w * g.width;
  const sh = bounds.h * g.height;
  // …and the part of it the frame shows.
  const ix0 = Math.max(0, sx);
  const iy0 = Math.max(0, sy);
  const ix1 = Math.min(el.w, sx + sw);
  const iy1 = Math.min(el.h, sy + sh);
  if (ix1 - ix0 < 1 || iy1 - iy0 < 1 || sw <= 0 || sh <= 0) return null;
  const inFrame = ix0 - sx < 0.5 && iy0 - sy < 0.5 && sx + sw - ix1 < 0.5 && sy + sh - iy1 < 0.5;
  let box = { x: sx, y: sy, w: sw, h: sh };
  let fit: "cover" | "contain" = "contain";
  let crop: DesignCrop = { ...DEFAULT_CROP };
  if (!inFrame) {
    const iw = ix1 - ix0;
    const ih = iy1 - iy0;
    // Cover scales to max(iw/sw, ih/sh) of the subject; zoom back up to 1:1.
    const zoom = 1 / Math.max(iw / sw, ih / sh);
    if (zoom <= 4) {
      box = { x: ix0, y: iy0, w: iw, h: ih };
      fit = "cover";
      // coverGeometry pans so (crop.x·width) sits at the box centre.
      crop = { x: Math.min(1, Math.max(0, (iw / 2 - (sx - ix0)) / sw)), y: Math.min(1, Math.max(0, (ih / 2 - (sy - iy0)) / sh)), zoom };
    }
  }
  // Box-local → canvas, turning the box centre about the picture's centre.
  const theta = ((el.rotation ?? 0) * Math.PI) / 180;
  const dx = box.x + box.w / 2 - el.w / 2;
  const dy = box.y + box.h / 2 - el.h / 2;
  const cx = el.x + el.w / 2 + dx * Math.cos(theta) - dy * Math.sin(theta);
  const cy = el.y + el.h / 2 + dx * Math.sin(theta) + dy * Math.cos(theta);
  return {
    x: Math.round(cx - box.w / 2),
    y: Math.round(cy - box.h / 2),
    w: Math.round(box.w),
    h: Math.round(box.h),
    fit,
    crop,
    ...(el.rotation ? { rotation: el.rotation } : {}),
  };
}
