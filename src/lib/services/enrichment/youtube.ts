import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveRemoteToS3, saveTranscript } from "./shared";
import type { EnrichmentResult } from "./types";

interface YTChannel {
  id?: string;
  title?: string;
  handle?: string;
  thumbnail?: string | null;
  subscriberCountInt?: number;
  isVerified?: boolean;
}

interface YTVideoResponse {
  id?: string;
  url?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  channel?: YTChannel;
  viewCountInt?: number;
  likeCountInt?: number;
  commentCountInt?: number;
  lengthSeconds?: number;
  publishDate?: string;
}

interface YTTranscriptCue {
  startMs?: number;
  durationMs?: number;
  text?: string;
}

interface YTTranscriptResponse {
  // SC's transcript endpoint shape varies; we accept either a single string
  // or a cue array. Defensive defaults below.
  transcript?: string;
  transcript_only_text?: string;
  transcript_with_timestamps?: YTTranscriptCue[];
  language?: string;
}

const YT_HOST_RE = /(^|\.)((youtube\.com)|(youtu\.be))$/;

export function isYouTubeUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return YT_HOST_RE.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function videoIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1) || null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function enrichYouTubeItem(
  itemId: string
): Promise<EnrichmentResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      posterS3Key: productionItems.posterS3Key,
      authorHandle: productionItems.authorHandle,
      description: productionItems.description,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);
  const url = item.youtubeUrl || item.publishedLink;
  if (!url || !isYouTubeUrl(url)) {
    throw new Error(`Item ${itemId} is not a YouTube URL: ${url ?? "(none)"}`);
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

  // /v1/youtube/video — full video metadata. 1 credit.
  const data = await scFetchJson<YTVideoResponse>("/v1/youtube/video", {
    url,
  });
  result.creditsSpent += 1;
  if (!data) {
    throw new ScrapeCreatorsError(
      `YT video not found at ${url}`,
      404,
      "/v1/youtube/video"
    );
  }

  if (data.description && data.description !== item.description) {
    result.updates.description = data.description;
    result.fields.descriptionFetched = true;
  }

  // Hook for long-form YouTube = the published video title (per the
  // dispatcher's rule 3). For Notion-authoritative items, `production_items
  // .title` is the editor's working title from Notion (e.g. "Author: Format -
  // Working theme") which is wrong for analytics; the live YT title is what
  // viewers click on. Stamp `hookSource='title'` so vision sweep can still
  // upgrade if the thumbnail has substantive overlay text.
  if (data.title) {
    const trimmedTitle = data.title.trim();
    if (trimmedTitle.length > 0) {
      result.updates.hook = trimmedTitle.slice(0, 240);
      result.updates.hookSource = "title";
      result.updates.hookExtractor = "yt-enricher:v1";
      result.updates.hookExtractedAt = new Date();
    }
  }

  // The SC listing endpoint (channel-videos) only returns ISO timestamps
  // for the last few weeks; older items come through as "N months/years
  // ago" and get dropped to null. /v1/youtube/video is authoritative, so
  // capture its publishDate here and heal any null or previously-batched
  // row. Parses "YYYY-MM-DD" (SC's usual shape) or a full ISO string.
  if (data.publishDate) {
    const d = new Date(data.publishDate);
    if (!isNaN(d.getTime())) {
      result.updates.publishedAt = d;
      result.updates.publishedDate = d.toISOString().split("T")[0];
      result.fields.publishDateFetched = true;
    }
  }

  const channel = data.channel;
  if (channel?.handle || channel?.title) {
    result.updates.authorHandle = channel.handle ?? null;
    result.updates.authorDisplayName = channel.title ?? null;
    result.updates.authorVerified = channel.isVerified ?? null;
    if (typeof channel.subscriberCountInt === "number") {
      result.updates.authorFollowerCount = channel.subscriberCountInt;
    }
    result.fields.authorFetched = true;
  }

  // Archive thumbnail to S3 — YouTube's i.ytimg.com URLs are stable but
  // owning a copy means we don't bind our UI to YouTube's continued service.
  if (!item.posterS3Key && data.thumbnail) {
    try {
      const vid = videoIdFromUrl(url) ?? "video";
      const archived = await archiveRemoteToS3(
        itemId,
        data.thumbnail,
        `${vid}-poster`
      );
      result.updates.posterS3Key = archived.key;
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.fields.posterArchived = true;
    } catch (err) {
      console.warn(
        `[yt-enrich] poster archive failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // /v1/youtube/video/transcript — captions when available. 1 credit.
  if (!existingTranscript) {
    try {
      const t = await scFetchJson<YTTranscriptResponse>(
        "/v1/youtube/video/transcript",
        { url }
      );
      result.creditsSpent += 1;
      const cues = t?.transcript_with_timestamps;
      const fullText =
        t?.transcript ||
        t?.transcript_only_text ||
        (cues || []).map((c) => c.text ?? "").join(" ").trim();

      if (fullText && fullText.length > 0) {
        const segments = cues?.length
          ? cues.map((c) => ({
              startSec: (c.startMs ?? 0) / 1000,
              endSec: ((c.startMs ?? 0) + (c.durationMs ?? 0)) / 1000,
              text: c.text ?? "",
            }))
          : undefined;
        await saveTranscript(itemId, {
          source: "scrape_creators_youtube",
          fullText,
          segments,
          language: t?.language ?? "en",
          durationSec: data.lengthSeconds,
        });
        result.fields.transcriptFetched = true;
      }
    } catch (err) {
      console.warn(
        `[yt-enrich] transcript fetch failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  result.updates.updatedAt = new Date();
  return result;
}
