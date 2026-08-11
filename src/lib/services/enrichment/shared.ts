import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItemMedia, transcripts } from "@/lib/db/schema";
import { buildKey, bucketName, putObject } from "@/lib/s3";

/** Defensive cap on anything we pull into memory. `archiveRemoteToS3`
 *  buffers the whole asset via `arrayBuffer()` before uploading, so this is
 *  bounded by the Basic dyno's 512 MB — raising it trades directly against
 *  R14/R15. */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/**
 * Thrown when a remote asset is larger than `MAX_MEDIA_BYTES`.
 *
 * Distinct from a generic download failure because it is *deterministic*:
 * the same URL is the same size on every retry, so a caller that blindly
 * rethrows burns its whole graphile-worker retry budget and ends as a queue
 * corpse. Callers should surface this to a human instead. The message is
 * unchanged from the pre-2026-08-11 inline `throw new Error(...)` so existing
 * log and Sentry signatures still match.
 */
export class MediaTooLargeError extends Error {
  readonly bytes: number;
  readonly limit = MAX_MEDIA_BYTES;

  constructor(bytes: number) {
    super(`Remote media is ${bytes} bytes — above ${MAX_MEDIA_BYTES} limit`);
    this.name = "MediaTooLargeError";
    this.bytes = bytes;
  }
}

function extFromContentType(ct: string): string {
  if (ct.startsWith("video/mp4")) return "mp4";
  if (ct === "video/quicktime") return "mov";
  if (ct === "image/png") return "png";
  if (ct === "image/webp") return "webp";
  if (ct === "image/jpeg" || ct === "image/jpg") return "jpg";
  return "bin";
}

function fallbackContentType(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

export interface ArchiveResult {
  key: string;
  size: number;
  contentType: string;
}

/**
 * Fetch a remote URL into our S3 bucket under a key tied to the item.
 * Defensive 200 MB cap prevents a runaway download from blowing the box.
 * Throws on download or upload failure — callers decide whether to swallow.
 */
export async function archiveRemoteToS3(
  productionItemId: string,
  remoteUrl: string,
  fileNameHint: string
): Promise<ArchiveResult> {
  const res = await fetch(remoteUrl);
  if (!res.ok) {
    throw new Error(
      `Failed to download ${remoteUrl}: ${res.status} ${res.statusText}`
    );
  }
  const headerLen = Number(res.headers.get("content-length") ?? 0);
  if (headerLen && headerLen > MAX_MEDIA_BYTES) {
    throw new MediaTooLargeError(headerLen);
  }
  const arr = await res.arrayBuffer();
  if (arr.byteLength > MAX_MEDIA_BYTES) {
    throw new MediaTooLargeError(arr.byteLength);
  }
  const contentType =
    res.headers.get("content-type") ?? fallbackContentType(remoteUrl);
  const ext = extFromContentType(contentType);
  const safeName = fileNameHint.endsWith(`.${ext}`)
    ? fileNameHint
    : `${fileNameHint}.${ext}`;
  const key = buildKey(productionItemId, safeName);
  await putObject(key, Buffer.from(arr), contentType);
  return { key, size: arr.byteLength, contentType };
}

export interface CarouselSlide {
  /** Remote URL to archive. For video slides, the actual video file. */
  url: string;
  /** What kind of media this slide is. `archiveRemoteToS3` will auto-detect
   *  content-type from the HTTP response, but the enricher knows ahead of time
   *  whether the slide is a photo or a video. Drives the UI render choice. */
  kind: "image" | "video";
  /** For video slides, the still-frame / cover image URL. Archived separately
   *  so the gallery can render a thumb without loading the video. */
  posterUrl?: string;
  /** Stem for the S3 key (uuid + extension are appended automatically). */
  fileNameHint: string;
}

export interface ArchiveCarouselResult {
  archived: number;
  total: number;
  /** Index-0 result so callers can mirror the cover into legacy single-media
   *  columns on production_items. */
  primary: ArchiveResult | null;
  primaryPoster: ArchiveResult | null;
  /** Rows the helper actually inserted or replaced, in slide-index order.
   *  Workers use this to emit one `media_added` event per affected slide
   *  for the activity-feed audit trail. Empty when archive was a complete
   *  no-op (every slide's sourceUrl already matched what's in the table). */
  affected: AffectedSlide[];
}

export interface AffectedSlide {
  mediaId: string;
  index: number;
  kind: "image" | "video";
  s3Key: string;
  posterS3Key: string | null;
  mode: "inserted" | "replaced";
}

/**
 * Archive every slide of a carousel/multi-media post to S3 and upsert rows
 * into `production_item_media` keyed by (productionItemId, index). Idempotent
 * — an existing row with the same `sourceUrl` is left untouched so re-runs
 * don't re-download. A row whose sourceUrl no longer matches the upstream is
 * replaced (covers the "post was edited" edge case).
 *
 * Per-slide failures are logged and skipped; the function does not throw on a
 * single bad slide so a broken URL doesn't block the rest of the carousel.
 */
export async function archiveCarouselMedia(
  productionItemId: string,
  slides: CarouselSlide[]
): Promise<ArchiveCarouselResult> {
  const out: ArchiveCarouselResult = {
    archived: 0,
    total: slides.length,
    primary: null,
    primaryPoster: null,
    affected: [],
  };
  if (!slides.length) return out;

  const existing = await db
    .select({
      id: productionItemMedia.id,
      index: productionItemMedia.index,
      sourceUrl: productionItemMedia.sourceUrl,
      s3Key: productionItemMedia.s3Key,
      posterS3Key: productionItemMedia.posterS3Key,
      contentType: productionItemMedia.contentType,
      sizeBytes: productionItemMedia.sizeBytes,
    })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, productionItemId));
  const existingByIndex = new Map(existing.map((r) => [r.index, r]));

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const prev = existingByIndex.get(i);
    if (prev && prev.sourceUrl === slide.url) {
      // Already archived for this source URL. Capture the primary result so
      // the caller can still mirror it to legacy columns on re-run.
      if (i === 0) {
        out.primary = {
          key: prev.s3Key,
          size: prev.sizeBytes ?? 0,
          contentType: prev.contentType,
        };
        if (prev.posterS3Key) {
          out.primaryPoster = {
            key: prev.posterS3Key,
            size: 0,
            contentType: "image/jpeg",
          };
        }
      }
      continue;
    }

    let mediaRes: ArchiveResult;
    try {
      mediaRes = await archiveRemoteToS3(
        productionItemId,
        slide.url,
        `${slide.fileNameHint}-${i}`
      );
    } catch (err) {
      console.warn(
        `[carousel-archive] slide ${i} media failed for ${productionItemId}:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }

    let posterRes: ArchiveResult | null = null;
    if (slide.kind === "video" && slide.posterUrl) {
      try {
        posterRes = await archiveRemoteToS3(
          productionItemId,
          slide.posterUrl,
          `${slide.fileNameHint}-${i}-poster`
        );
      } catch (err) {
        console.warn(
          `[carousel-archive] slide ${i} poster failed for ${productionItemId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    const row = {
      productionItemId,
      index: i,
      kind: slide.kind,
      s3Bucket: bucketName(),
      s3Key: mediaRes.key,
      contentType: mediaRes.contentType,
      sizeBytes: mediaRes.size,
      posterS3Key: posterRes?.key ?? null,
      sourceUrl: slide.url,
      uploadedAt: new Date(),
    };
    let mediaId: string;
    let mode: "inserted" | "replaced";
    if (prev) {
      const [returned] = await db
        .update(productionItemMedia)
        .set(row)
        .where(
          and(
            eq(productionItemMedia.productionItemId, productionItemId),
            eq(productionItemMedia.index, i)
          )
        )
        .returning({ id: productionItemMedia.id });
      mediaId = returned.id;
      mode = "replaced";
    } else {
      const [returned] = await db
        .insert(productionItemMedia)
        .values(row)
        .returning({ id: productionItemMedia.id });
      mediaId = returned.id;
      mode = "inserted";
    }

    out.archived += 1;
    out.affected.push({
      mediaId,
      index: i,
      kind: slide.kind,
      s3Key: mediaRes.key,
      posterS3Key: posterRes?.key ?? null,
      mode,
    });
    if (i === 0) {
      out.primary = mediaRes;
      out.primaryPoster = posterRes;
    }
  }

  return out;
}

export interface TranscriptInput {
  /** e.g. "scrape_creators_instagram", "scrape_creators_youtube". */
  source: string;
  /** Plain-text transcript. Required. */
  fullText: string;
  /** Raw VTT/SRT if the platform returns one. Otherwise we synthesize a
   *  single-cue VTT so the column's NOT NULL constraint is honored. */
  rawVtt?: string;
  /** Time-coded segments if available. We synthesize a single segment when
   *  the platform only returns text. */
  segments?: Array<{
    startSec: number;
    endSec: number;
    text: string;
    speaker?: string;
  }>;
  language?: string;
  durationSec?: number;
}

/**
 * Idempotently write a transcript for a production item. The `transcripts`
 * table has a unique constraint on `productionItemId`, so we do an upsert
 * rather than blind insert. A second call with the same source + text is a
 * no-op via ON CONFLICT DO UPDATE.
 */
export async function saveTranscript(
  productionItemId: string,
  input: TranscriptInput
): Promise<void> {
  const fullText = input.fullText.trim();
  if (!fullText) return;

  const segments = input.segments ?? [
    {
      startSec: 0,
      endSec: input.durationSec ?? 0,
      text: fullText,
    },
  ];
  const rawVtt =
    input.rawVtt ??
    `WEBVTT\n\n00:00:00.000 --> ${secondsToVtt(input.durationSec ?? 0)}\n${fullText}\n`;
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  const existing = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(transcripts)
      .set({
        source: input.source,
        language: input.language ?? "en",
        rawVtt,
        fullText,
        segments,
        wordCount,
        durationSec: input.durationSec?.toString() ?? null,
        fetchedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(transcripts.productionItemId, productionItemId));
  } else {
    await db.insert(transcripts).values({
      productionItemId,
      source: input.source,
      language: input.language ?? "en",
      rawVtt,
      fullText,
      segments,
      wordCount,
      durationSec: input.durationSec?.toString() ?? null,
    });
  }
}

function secondsToVtt(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000`;
}
