import { describe, expect, it } from "vitest";
import type { DesignDoc } from "./doc";
import { REUSE_MAX_AGE_MS, reusableVideoPages, type PreviousExport, type RenderedPageOutput } from "./reuse-pages";

const canvas = { width: 1080, height: 1350 };
const videoPage = (id: string, startSec = 10) => ({
  id,
  elements: [{ id: `v-${id}`, type: "video", x: 0, y: 0, w: 1080, h: 600, startSec, endSec: startSec + 20 }],
});
const picturePage = (id: string, fontSize = 64) => ({
  id,
  elements: [{ id: `t-${id}`, type: "text", x: 40, y: 40, w: 1000, h: 200, style: { fontSize } }],
});
const doc = (pages: unknown[], c = canvas) => ({ canvas: c, pages }) as unknown as DesignDoc;

const video = (n: number): RenderedPageOutput => ({ s3Key: `v${n}.mp4`, sizeBytes: 1000 + n, kind: "video", contentType: "video/mp4", posterS3Key: `v${n}.jpg` });
const image = (n: number): RenderedPageOutput => ({ s3Key: `p${n}.png`, sizeBytes: n, kind: "image", contentType: "image/png", posterS3Key: null });

const now = new Date("2026-11-27T12:00:00Z");
const prev = (d: DesignDoc, outputs: Array<RenderedPageOutput | null>, ageMs = 5 * 60 * 1000): PreviousExport => ({
  doc: d,
  outputs,
  finishedAt: new Date(now.getTime() - ageMs),
});

describe("reusableVideoPages", () => {
  it("reuses the unchanged video slide when only a picture slide was nudged (the common re-export)", () => {
    const before = doc([picturePage("a"), videoPage("b"), picturePage("c")]);
    const after = doc([picturePage("a", 72), videoPage("b"), picturePage("c")]);
    const reuse = reusableVideoPages(after, prev(before, [image(0), video(1), image(2)]), now);
    expect([...reuse.keys()]).toEqual([1]);
    expect(reuse.get(1)).toEqual(video(1));
  });

  it("re-cuts a video slide that changed (trim, captions, layout)", () => {
    const before = doc([videoPage("b", 10)]);
    const after = doc([videoPage("b", 12)]);
    expect(reusableVideoPages(after, prev(before, [video(0)]), now).size).toBe(0);
  });

  it("never reuses picture slides — they render in about a second", () => {
    const d = doc([picturePage("a")]);
    expect(reusableVideoPages(d, prev(d, [image(0)]), now).size).toBe(0);
  });

  it("follows a video slide that moved to another position", () => {
    const before = doc([videoPage("b"), picturePage("a")]);
    const after = doc([picturePage("a"), videoPage("b")]);
    const reuse = reusableVideoPages(after, prev(before, [video(0), image(1)]), now);
    expect(reuse.get(1)).toEqual(video(0));
    expect(reuse.has(0)).toBe(false);
  });

  it("uses each previous output once when a slide was duplicated", () => {
    const before = doc([videoPage("b")]);
    const after = doc([videoPage("b"), videoPage("b")]);
    const reuse = reusableVideoPages(after, prev(before, [video(0)]), now);
    expect(reuse.size).toBe(1);
  });

  it("renders everything fresh when the canvas changed, the export is old, or its output is unknown", () => {
    const d = doc([videoPage("b")]);
    expect(reusableVideoPages(doc([videoPage("b")], { width: 1080, height: 1080 }), prev(d, [video(0)]), now).size).toBe(0);
    expect(reusableVideoPages(d, prev(d, [video(0)], REUSE_MAX_AGE_MS + 1), now).size).toBe(0);
    expect(reusableVideoPages(d, prev(d, [null]), now).size).toBe(0);
    expect(reusableVideoPages(d, prev(d, [{ ...video(0), posterS3Key: null }]), now).size).toBe(0);
    expect(reusableVideoPages(d, null, now).size).toBe(0);
  });
});
