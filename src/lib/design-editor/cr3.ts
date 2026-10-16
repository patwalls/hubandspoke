/**
 * Canon RAW (.cr3) → JPEG, in the browser, before a founder photo uploads.
 *
 * Browsers can't decode RAW, but every CR3 carries a full-size JPEG of the
 * shot as its first track (ISO-BMFF: moov/trak[0] → stsz + co64/stco point
 * at it in mdat), plus a ~1620px preview in a top-level `PRVW` uuid box. We
 * lift the full-size one (falling back to the preview), apply the camera's
 * orientation from the CMT1 TIFF header (the embedded JPEG has no EXIF of
 * its own), and re-encode — so the upload is an ordinary JPG of a few MB
 * instead of a 20–40 MB RAW the server would refuse. Layout per
 * https://github.com/lclevy/canon_cr3.
 */

export interface Cr3Jpeg {
  jpeg: Uint8Array;
  /** EXIF orientation (1 = upright, 3 = 180°, 6 = 90° CW, 8 = 90° CCW). */
  orientation: number;
}

const CANON_UUID = "85c0b687820f11e08111f4ce462b6a48";
const PRVW_UUID = "eaf42b5e1c984b88b9fbb7dc406e4d16";

interface Box {
  type: string;
  /** Start of the payload (after the header). */
  start: number;
  end: number;
}

function* boxes(v: DataView, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(v.getUint8(p + 4), v.getUint8(p + 5), v.getUint8(p + 6), v.getUint8(p + 7));
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) return;
      size = Number(v.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < header || p + size > to) return;
    yield { type, start: p + header, end: p + size };
    p += size;
  }
}

function child(v: DataView, parent: Box, type: string): Box | null {
  for (const b of boxes(v, parent.start, parent.end)) if (b.type === type) return b;
  return null;
}

function uuidOf(v: DataView, b: Box): string {
  let s = "";
  for (let i = 0; i < 16 && b.start + i < b.end; i++) s += v.getUint8(b.start + i).toString(16).padStart(2, "0");
  return s;
}

function isJpeg(buf: Uint8Array, at: number): boolean {
  return buf[at] === 0xff && buf[at + 1] === 0xd8 && buf[at + 2] === 0xff;
}

/** The full-size JPEG track: first trak's first sample. */
function trackJpeg(buf: Uint8Array, v: DataView, moov: Box): Uint8Array | null {
  const trak = child(v, moov, "trak");
  const mdia = trak && child(v, trak, "mdia");
  const minf = mdia && child(v, mdia, "minf");
  const stbl = minf && child(v, minf, "stbl");
  if (!stbl) return null;
  const stsz = child(v, stbl, "stsz");
  const co64 = child(v, stbl, "co64");
  const stco = child(v, stbl, "stco");
  if (!stsz || (!co64 && !stco)) return null;
  // stsz: version/flags(4) sample_size(4) count(4) [sizes…]
  let size = v.getUint32(stsz.start + 4);
  if (size === 0) size = v.getUint32(stsz.start + 12);
  // co64/stco: version/flags(4) count(4) offsets…
  const offset = co64 ? Number(v.getBigUint64(co64.start + 8)) : v.getUint32(stco!.start + 8);
  if (!size || offset + size > buf.length || !isJpeg(buf, offset)) return null;
  return buf.subarray(offset, offset + size);
}

/** The ~1620px preview inside the top-level PRVW uuid box. */
function previewJpeg(buf: Uint8Array, box: Box): Uint8Array | null {
  for (let p = box.start + 16; p + 3 <= box.end; p++) {
    if (isJpeg(buf, p)) return buf.subarray(p, box.end);
  }
  return null;
}

/** Orientation tag (0x0112) from CMT1, a TIFF IFD0. */
function orientationFrom(v: DataView, cmt1: Box): number {
  const t = cmt1.start;
  const little = v.getUint16(t) === 0x4949;
  const ifd = t + v.getUint32(t + 4, little);
  if (ifd + 2 > cmt1.end) return 1;
  const n = v.getUint16(ifd, little);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > cmt1.end) break;
    if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little) || 1;
  }
  return 1;
}

export function isCr3(file: { name: string; type: string }): boolean {
  return /\.cr3$/i.test(file.name) || file.type === "image/x-canon-cr3";
}

/** Pull the embedded JPEG out of a CR3, or null if it isn't one we can read. */
export function extractCr3Jpeg(buf: Uint8Array): Cr3Jpeg | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let moov: Box | null = null;
  let prvw: Box | null = null;
  try {
    for (const b of boxes(v, 0, buf.length)) {
      if (b.type === "moov") moov = b;
      else if (b.type === "uuid" && uuidOf(v, b) === PRVW_UUID) prvw = b;
    }
    let orientation = 1;
    let jpeg: Uint8Array | null = null;
    if (moov) {
      for (const b of boxes(v, moov.start, moov.end)) {
        if (b.type !== "uuid" || uuidOf(v, b) !== CANON_UUID) continue;
        const cmt1 = child(v, { type: "uuid", start: b.start + 16, end: b.end }, "CMT1");
        if (cmt1) orientation = orientationFrom(v, cmt1);
      }
      jpeg = trackJpeg(buf, v, moov);
    }
    jpeg ??= prvw ? previewJpeg(buf, prvw) : null;
    return jpeg ? { jpeg, orientation } : null;
  } catch {
    return null;
  }
}

/** Longest side of the converted JPEG — plenty for a 1080-wide cover, and
 *  keeps the upload well under the server's limits. */
const MAX_SIDE = 4000;

/** Browser only: a .cr3 File → an upright JPEG File (same base name). */
export async function cr3ToJpegFile(file: File): Promise<File> {
  const found = extractCr3Jpeg(new Uint8Array(await file.arrayBuffer()));
  if (!found) throw new Error("Couldn't read that .cr3 — export it as a JPG and upload that");
  const bitmap = await createImageBitmap(new Blob([found.jpeg as BlobPart], { type: "image/jpeg" }), { imageOrientation: "none" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const sideways = found.orientation === 6 || found.orientation === 8;
  const canvas = document.createElement("canvas");
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (found.orientation === 3) ctx.rotate(Math.PI);
  else if (found.orientation === 6) ctx.rotate(Math.PI / 2);
  else if (found.orientation === 8) ctx.rotate(-Math.PI / 2);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("Couldn't convert that .cr3 — export it as a JPG and upload that");
  return new File([blob], file.name.replace(/\.cr3$/i, ".jpg"), { type: "image/jpeg" });
}
