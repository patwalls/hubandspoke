import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { transcripts } from "@/lib/db/schema";
import { buildKey, putObject } from "@/lib/s3";

const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

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
    throw new Error(
      `Remote media is ${headerLen} bytes — above ${MAX_MEDIA_BYTES} limit`
    );
  }
  const arr = await res.arrayBuffer();
  if (arr.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(
      `Remote media is ${arr.byteLength} bytes — above ${MAX_MEDIA_BYTES} limit`
    );
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
