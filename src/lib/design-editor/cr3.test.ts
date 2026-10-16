import { describe, expect, it } from "vitest";
import { extractCr3Jpeg, isCr3 } from "./cr3";

const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number) => [...u32(0), ...u32(n)];
const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const hex = (h: string) => h.match(/../g)!.map((x) => parseInt(x, 16));
const box = (type: string, ...payload: (number[] | Uint8Array)[]) => {
  const body = bytes(...payload);
  return bytes(u32(8 + body.length), str(type), body);
};

const FULL = bytes([0xff, 0xd8, 0xff, 0xe0], str("full-size"), [0xff, 0xd9]);
const PREVIEW = bytes([0xff, 0xd8, 0xff, 0xdb], str("preview"), [0xff, 0xd9]);

/** IFD0 with one entry: Orientation (0x0112), SHORT, little-endian. */
const cmt1 = (orientation: number) =>
  box("CMT1", [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0], [1, 0], [0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0], [0, 0, 0, 0]);

function cr3(opts: { orientation?: number; withTrack?: boolean; withPreview?: boolean }) {
  const canon = box("uuid", hex("85c0b687820f11e08111f4ce462b6a48"), cmt1(opts.orientation ?? 1));
  const prvw = box("uuid", hex("eaf42b5e1c984b88b9fbb7dc406e4d16"), new Array(8).fill(0), box("PRVW", new Array(12).fill(0), PREVIEW));
  const ftyp = box("ftyp", str("crx "), u32(1));
  // Build moov with a placeholder offset, then patch once its length is known.
  const moovFor = (offset: number) => {
    const stbl = box("stbl", box("stsz", u32(0), u32(0), u32(1), u32(FULL.length)), box("co64", u32(0), u32(1), u64(offset)));
    const trak = opts.withTrack === false ? bytes() : box("trak", box("mdia", box("minf", stbl)));
    return box("moov", canon, trak);
  };
  const head = (offset: number) => bytes(ftyp, moovFor(offset), opts.withPreview === false ? [] : prvw);
  const offset = head(0).length + 8;
  return bytes(head(offset), box("mdat", FULL));
}

describe("extractCr3Jpeg", () => {
  it("lifts the full-size JPEG track and the camera's orientation", () => {
    const out = extractCr3Jpeg(cr3({ orientation: 6 }));
    expect(out && Array.from(out.jpeg)).toEqual(Array.from(FULL));
    expect(out?.orientation).toBe(6);
  });

  it("falls back to the PRVW preview when there's no readable track", () => {
    const out = extractCr3Jpeg(cr3({ withTrack: false }));
    expect(out && Array.from(out.jpeg)).toEqual(Array.from(PREVIEW));
    expect(out?.orientation).toBe(1);
  });

  it("returns null for something that isn't a CR3", () => {
    expect(extractCr3Jpeg(cr3({ withTrack: false, withPreview: false }))).toBeNull();
    expect(extractCr3Jpeg(bytes(str("not a raw file at all")))).toBeNull();
  });
});

describe("isCr3", () => {
  it("matches by extension or MIME type", () => {
    expect(isCr3({ name: "IMG_0001.CR3", type: "" })).toBe(true);
    expect(isCr3({ name: "x", type: "image/x-canon-cr3" })).toBe(true);
    expect(isCr3({ name: "IMG_0001.jpg", type: "image/jpeg" })).toBe(false);
  });
});
