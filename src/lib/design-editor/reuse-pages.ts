/**
 * Re-export without re-cutting the video. Designers export a post, look at
 * it, nudge one slide (a box, a font size) and export again within minutes;
 * almost always the slide they touched is a picture slide, yet every export
 * re-cut the video slide from the source (~30 s of the ~34 s wait). A video
 * slide whose page is exactly what the last finished export rendered, on
 * the same canvas, is reused from that export instead.
 *
 * S3 keys are unique per upload (`buildKey` adds a UUID) and installing a new
 * carousel only removes media ROWS, never objects, so the previous export's
 * files stay valid to point at.
 *
 * Pure: the render task loads the previous export and its media rows.
 */
import type { DesignDoc } from "./doc";
import { pageVideo } from "./doc";

export interface RenderedPageOutput {
  s3Key: string;
  sizeBytes: number;
  kind: "image" | "video";
  contentType: string;
  posterS3Key: string | null;
}

/** The video page also depends on things outside its JSON (the transcript
 *  behind the captions, the channel's avatar): only reuse a recent export. */
export const REUSE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface PreviousExport {
  doc: DesignDoc;
  finishedAt: Date;
  /** Output per page index, aligned with `doc.pages` (null = unknown). */
  outputs: Array<RenderedPageOutput | null>;
}

/**
 * Page index in `doc` → the previous export's output to reuse. Only video
 * pages (picture slides render in about a second, not worth the risk), only
 * an identical page on an identical canvas, each previous output used once.
 */
export function reusableVideoPages(
  doc: DesignDoc,
  previous: PreviousExport | null,
  now: Date = new Date(),
): Map<number, RenderedPageOutput> {
  const reuse = new Map<number, RenderedPageOutput>();
  if (!previous) return reuse;
  if (now.getTime() - previous.finishedAt.getTime() > REUSE_MAX_AGE_MS) return reuse;
  if (JSON.stringify(previous.doc.canvas) !== JSON.stringify(doc.canvas)) return reuse;

  const candidates = previous.doc.pages.map((page, j) => {
    const out = previous.outputs[j];
    return out && out.kind === "video" && out.posterS3Key && pageVideo(page) ? { key: JSON.stringify(page), out } : null;
  });
  for (const [i, page] of doc.pages.entries()) {
    if (!pageVideo(page)) continue;
    const key = JSON.stringify(page);
    const j = candidates.findIndex((c) => c?.key === key);
    if (j < 0) continue;
    reuse.set(i, candidates[j]!.out);
    candidates[j] = null;
  }
  return reuse;
}
