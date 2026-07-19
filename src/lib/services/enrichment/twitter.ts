import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { PermanentEnrichmentError } from "./errors";
import {
  archiveCarouselMedia,
  saveTranscript,
  type CarouselSlide,
} from "./shared";
import type { EnrichmentResult } from "./types";

interface XUserLegacy {
  screen_name?: string;
  name?: string;
  followers_count?: number;
  verified?: boolean;
  is_blue_verified?: boolean;
}

interface XUserResult {
  result?: { legacy?: XUserLegacy; is_blue_verified?: boolean };
}

interface XMediaVariant {
  bitrate?: number;
  url?: string;
  content_type?: string;
}

interface XMedia {
  type?: "photo" | "video" | "animated_gif" | string;
  media_url_https?: string;
  video_info?: { variants?: XMediaVariant[] };
}

interface XTweetResponse {
  // SC wraps under different keys; the `fetchTweetByUrl` shim already
  // normalizes to `data.tweet || data.data || data` — we accept all three.
  rest_id?: string;
  legacy?: {
    full_text?: string;
    entities?: { media?: XMedia[] };
    extended_entities?: { media?: XMedia[] };
  };
  core?: { user_results?: XUserResult };
  views?: { count?: string };
  data?: unknown;
  tweet?: unknown;
}

interface XTranscriptResponse {
  success?: boolean;
  transcript?: string;
}

const X_HOST_RE = /(^|\.)((twitter\.com)|(x\.com))$/;

export function isTwitterUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return X_HOST_RE.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function tweetIdFromUrl(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/status\/(\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function unwrapTweet(raw: XTweetResponse | null): XTweetResponse | null {
  if (!raw) return null;
  const inner = (raw.tweet ?? raw.data ?? raw) as XTweetResponse;
  return inner;
}

function bestVideoVariant(variants: XMediaVariant[] | undefined): string | null {
  if (!variants?.length) return null;
  const mp4s = variants.filter(
    (v) => v.content_type === "video/mp4" && v.url
  );
  if (!mp4s.length) return variants[0]?.url ?? null;
  mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return mp4s[0].url ?? null;
}

export async function enrichTwitterItem(
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
  if (!item.publishedLink || !isTwitterUrl(item.publishedLink)) {
    throw new PermanentEnrichmentError(
      `Item ${itemId} is not a Twitter/X URL: ${item.publishedLink ?? "(none)"}`
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

  const raw = await scFetchJson<XTweetResponse>("/v1/twitter/tweet", {
    url: item.publishedLink,
  });
  result.creditsSpent += 1;
  const tweet = unwrapTweet(raw);
  if (!tweet) {
    throw new ScrapeCreatorsError(
      `Tweet not found at ${item.publishedLink}`,
      404,
      "/v1/twitter/tweet"
    );
  }

  const fullText = tweet.legacy?.full_text;
  if (fullText && fullText.trim().length > 0) {
    result.updates.contentBody = fullText;
    result.updates.contentBodyFetchedAt = new Date();
    result.updates.contentBodySource = "scrape_creators";
    result.fields.captionFetched = true;
  }

  const userLegacy = tweet.core?.user_results?.result?.legacy;
  if (userLegacy?.screen_name || userLegacy?.name) {
    result.updates.authorHandle = userLegacy.screen_name ?? null;
    result.updates.authorDisplayName = userLegacy.name ?? null;
    result.updates.authorVerified =
      tweet.core?.user_results?.result?.is_blue_verified ??
      userLegacy.verified ??
      null;
    if (typeof userLegacy.followers_count === "number") {
      result.updates.authorFollowerCount = userLegacy.followers_count;
    }
    result.fields.authorFetched = true;
  }

  // Media archive — `extended_entities.media` is more complete than
  // `entities.media` for tweets with multiple/video attachments. Up to 4
  // media items per tweet; we archive all of them.
  const mediaEntries =
    tweet.legacy?.extended_entities?.media ??
    tweet.legacy?.entities?.media ??
    [];
  const tweetId = tweetIdFromUrl(item.publishedLink) ?? "tweet";
  const slides: CarouselSlide[] = [];
  for (const m of mediaEntries) {
    if (m.type === "video" || m.type === "animated_gif") {
      const videoUrl = bestVideoVariant(m.video_info?.variants);
      if (videoUrl) {
        slides.push({
          url: videoUrl,
          kind: "video",
          posterUrl: m.media_url_https,
          fileNameHint: tweetId,
        });
      } else if (m.media_url_https) {
        // No video variant — fall back to the still image.
        slides.push({
          url: m.media_url_https,
          kind: "image",
          fileNameHint: tweetId,
        });
      }
    } else if (m.media_url_https) {
      slides.push({
        url: m.media_url_https,
        kind: "image",
        fileNameHint: tweetId,
      });
    }
  }

  if (slides.length > 0) {
    const res = await archiveCarouselMedia(itemId, slides);
    if (res.primary) {
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.updates.mediaS3Key = res.primary.key;
      result.updates.mediaContentType = res.primary.contentType;
      result.updates.mediaSizeBytes = res.primary.size;
      result.updates.mediaS3UploadedAt = new Date();
      result.fields.mediaArchived = res.archived > 0;
    }
    // Mirror slide-0 poster (video still frame) if present, else fall back to
    // slide-0 image so the cover thumbnail has a durable source.
    if (!item.posterS3Key) {
      if (res.primaryPoster) {
        result.updates.posterS3Key = res.primaryPoster.key;
        result.fields.posterArchived = true;
      } else if (res.primary && slides[0]?.kind === "image") {
        result.updates.posterS3Key = res.primary.key;
        result.fields.posterArchived = true;
      }
    }
  }

  // Video tweet transcript. SC's docs note this only works for video tweets.
  const isVideoTweet = mediaEntries[0]?.type === "video";
  if (isVideoTweet && !existingTranscript) {
    try {
      const t = await scFetchJson<XTranscriptResponse>(
        "/v1/twitter/tweet/transcript",
        { url: item.publishedLink }
      );
      result.creditsSpent += 1;
      const text = t?.transcript;
      if (text && text.trim().length > 0) {
        await saveTranscript(itemId, {
          source: "scrape_creators_twitter",
          fullText: text,
        });
        result.fields.transcriptFetched = true;
      }
    } catch (err) {
      console.warn(
        `[x-enrich] transcript fetch failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  result.updates.updatedAt = new Date();
  return result;
}
