import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveRemoteToS3, saveTranscript } from "./shared";
import { PermanentEnrichmentError } from "./errors";
import type { EnrichmentResult } from "./types";

interface TTAuthor {
  unique_id?: string;
  nickname?: string;
  follower_count?: number;
  custom_verify?: string;
  verification_type?: number;
}

interface TTVideoMeta {
  play_addr?: { url_list?: string[] };
  download_addr?: { url_list?: string[] };
  cover?: { url_list?: string[] };
  origin_cover?: { url_list?: string[] };
  duration?: number;
}

interface TTAwemeDetail {
  aweme_id?: string;
  desc?: string;
  text_extra?: Array<{ hashtag_name?: string; type?: number }>;
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
  };
  author?: TTAuthor;
  video?: TTVideoMeta;
  music?: { id_str?: string; title?: string; author?: string };
  create_time?: number;
}

interface TTVideoResponse {
  aweme_detail?: TTAwemeDetail;
}

interface TTTranscriptResponse {
  // SC's TikTok transcript can be plain text or WebVTT depending on caller.
  transcript?: string;
  transcript_text?: string;
  vtt?: string;
  webvtt?: string;
  language?: string;
}

const TT_HOST_RE = /(^|\.)tiktok\.com$/;

export function isTikTokUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return TT_HOST_RE.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function awemeIdFromUrl(url: string): string {
  try {
    const m = new URL(url).pathname.match(/\/video\/(\d+)/);
    return m?.[1] ?? "tiktok";
  } catch {
    return "tiktok";
  }
}

function pickFirst(urls: string[] | undefined): string | null {
  return urls?.find((u) => !!u) ?? null;
}

export async function enrichTikTokItem(
  itemId: string
): Promise<EnrichmentResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      contentBody: productionItems.contentBody,
      mediaS3Key: productionItems.mediaS3Key,
      posterS3Key: productionItems.posterS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);
  if (!item.publishedLink || !isTikTokUrl(item.publishedLink)) {
    throw new PermanentEnrichmentError(
      `Item ${itemId} is not a TikTok URL: ${item.publishedLink ?? "(none)"}`
    );
  }

  const result: EnrichmentResult = {
    updates: {},
    creditsSpent: 0,
    fields: {},
  };

  const [existingTranscript] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, itemId))
    .limit(1);

  // /v2/tiktok/video — full payload. 1 credit.
  const data = await scFetchJson<TTVideoResponse>("/v2/tiktok/video", {
    url: item.publishedLink,
  });
  result.creditsSpent += 1;
  const detail = data?.aweme_detail;
  if (!detail) {
    throw new ScrapeCreatorsError(
      `TikTok video not found at ${item.publishedLink}`,
      404,
      "/v2/tiktok/video"
    );
  }

  // TikTok descriptions ARE the post body — same role as a tweet's full_text
  // or an IG caption. Hashtags live inline in `desc`, no need to splice
  // `text_extra` separately.
  const desc = detail.desc;
  if (desc && desc.trim().length > 0) {
    result.updates.contentBody = desc;
    result.updates.contentBodyFetchedAt = new Date();
    result.updates.contentBodySource = "scrape_creators";
    result.fields.captionFetched = true;
  }

  const author = detail.author;
  if (author?.unique_id || author?.nickname) {
    result.updates.authorHandle = author.unique_id ?? null;
    result.updates.authorDisplayName = author.nickname ?? null;
    // TikTok marks verification via two fields; either non-empty → verified.
    result.updates.authorVerified =
      Boolean(author.custom_verify && author.custom_verify.length > 0) ||
      (author.verification_type ?? 0) > 0;
    if (typeof author.follower_count === "number") {
      result.updates.authorFollowerCount = author.follower_count;
    }
    result.fields.authorFetched = true;
  }

  const aweme = awemeIdFromUrl(item.publishedLink);

  // Cover image → poster.
  const coverUrl =
    pickFirst(detail.video?.cover?.url_list) ??
    pickFirst(detail.video?.origin_cover?.url_list);
  if (!item.posterS3Key && coverUrl) {
    try {
      const archived = await archiveRemoteToS3(
        itemId,
        coverUrl,
        `${aweme}-poster`
      );
      result.updates.posterS3Key = archived.key;
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.fields.posterArchived = true;
    } catch (err) {
      console.warn(
        `[tiktok-enrich] poster archive failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Video → media archive. play_addr is watermarked; download_addr is the
  // raw upload when SC has it. Prefer download_addr.
  const videoUrl =
    pickFirst(detail.video?.download_addr?.url_list) ??
    pickFirst(detail.video?.play_addr?.url_list);
  if (!item.mediaS3Key && videoUrl) {
    try {
      const archived = await archiveRemoteToS3(itemId, videoUrl, aweme);
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.updates.mediaS3Key = archived.key;
      result.updates.mediaS3UploadedAt = new Date();
      result.updates.mediaSizeBytes = archived.size;
      result.updates.mediaContentType = archived.contentType;
      result.fields.mediaArchived = true;
    } catch (err) {
      console.warn(
        `[tiktok-enrich] media archive failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Transcript via /v1/tiktok/video/transcript — native captions only (no
  // AI fallback) to keep the cost at 1 credit. Skip if we already have one.
  if (!existingTranscript) {
    try {
      const t = await scFetchJson<TTTranscriptResponse>(
        "/v1/tiktok/video/transcript",
        { url: item.publishedLink }
      );
      result.creditsSpent += 1;
      const text = t?.transcript ?? t?.transcript_text;
      const rawVtt = t?.vtt ?? t?.webvtt;
      if (text && text.trim().length > 0) {
        await saveTranscript(itemId, {
          source: "scrape_creators_tiktok",
          fullText: text,
          rawVtt,
          language: t?.language ?? "en",
          durationSec: detail.video?.duration,
        });
        result.fields.transcriptFetched = true;
      }
    } catch (err) {
      console.warn(
        `[tiktok-enrich] transcript fetch failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  result.updates.updatedAt = new Date();
  return result;
}
