import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveCarouselMedia, type CarouselSlide } from "./shared";
import { PermanentEnrichmentError } from "./errors";
import type { EnrichmentResult } from "./types";

interface YTCommunityChannel {
  title?: string;
  handle?: string;
  isVerified?: boolean;
  subscriberCountInt?: number;
}

interface YTCommunityImage {
  url?: string;
  width?: number;
  height?: number;
}

interface YTCommunityResponse {
  success?: boolean;
  text?: string;
  contentText?: string;
  postId?: string;
  publishedTime?: string;
  likeCount?: number;
  channel?: YTCommunityChannel;
  images?: YTCommunityImage[];
  attachment?: { images?: YTCommunityImage[] };
}

const COMMUNITY_PATH_RE = /\/(?:post|community)\//;

export function isYouTubeCommunityUrl(
  url: string | null | undefined
): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!u.hostname.includes("youtube.com")) return false;
    return COMMUNITY_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

// Build a slide list from SC's YT community payload. `data.images` holds
// slides for multi-image posts (and a single entry for a single image).
// `data.attachment.images` is the fallback when `images` is empty (older post
// types use this shape). We de-dup by the URL base (everything before `?`) to
// guard against the occasional multi-size response where the same image
// appears at several widths.
function buildSlides(
  data: YTCommunityResponse,
  stem: string
): CarouselSlide[] {
  const raw = data.images?.length ? data.images : data.attachment?.images ?? [];
  const seen = new Set<string>();
  const slides: CarouselSlide[] = [];
  for (const img of raw) {
    // SC occasionally returns a null/empty entry inside `images` — guard the
    // whole element, not just a missing `.url`, or we deref null. (HUBANDSPOKE-25)
    if (!img?.url) continue;
    const base = img.url.split("?")[0];
    if (seen.has(base)) continue;
    seen.add(base);
    slides.push({ url: img.url, kind: "image", fileNameHint: stem });
  }
  return slides;
}

export async function enrichYouTubeCommunityItem(
  itemId: string
): Promise<EnrichmentResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      contentBody: productionItems.contentBody,
      posterS3Key: productionItems.posterS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);
  if (!item.publishedLink || !isYouTubeCommunityUrl(item.publishedLink)) {
    throw new PermanentEnrichmentError(
      `Item ${itemId} is not a YT community URL: ${item.publishedLink ?? "(none)"}`
    );
  }

  const result: EnrichmentResult = {
    updates: {},
    creditsSpent: 0,
    fields: {},
  };

  const data = await scFetchJson<YTCommunityResponse>(
    "/v1/youtube/community-post",
    { url: item.publishedLink }
  );
  result.creditsSpent += 1;

  if (!data || data.success === false) {
    throw new ScrapeCreatorsError(
      `YT community post not found at ${item.publishedLink}`,
      404,
      "/v1/youtube/community-post"
    );
  }

  const body = data.text ?? data.contentText;
  if (body && body.trim().length > 0) {
    result.updates.contentBody = body;
    result.updates.contentBodyFetchedAt = new Date();
    result.updates.contentBodySource = "scrape_creators";
    result.fields.captionFetched = true;
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

  const slides = buildSlides(data, data.postId ?? "community");
  if (slides.length > 0) {
    const res = await archiveCarouselMedia(itemId, slides);
    if (res.primary) {
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.updates.mediaS3Key = res.primary.key;
      result.updates.mediaContentType = res.primary.contentType;
      result.updates.mediaSizeBytes = res.primary.size;
      result.updates.mediaS3UploadedAt = new Date();
      if (!item.posterS3Key) {
        result.updates.posterS3Key = res.primary.key;
        result.fields.posterArchived = true;
      }
      result.fields.mediaArchived = res.archived > 0;
    }
  }

  result.updates.updatedAt = new Date();
  return result;
}
