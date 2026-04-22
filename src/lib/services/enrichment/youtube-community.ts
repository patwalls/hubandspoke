import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveRemoteToS3 } from "./shared";
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

function pickLargestImage(
  images: YTCommunityImage[] | undefined
): string | null {
  if (!images?.length) return null;
  const withSize = images.filter((i) => i.url);
  if (!withSize.length) return null;
  withSize.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return withSize[0].url ?? null;
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
    throw new Error(
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

  const imageUrl =
    pickLargestImage(data.images) ??
    pickLargestImage(data.attachment?.images);
  if (!item.posterS3Key && imageUrl) {
    try {
      const archived = await archiveRemoteToS3(
        itemId,
        imageUrl,
        `${data.postId ?? "community"}-poster`
      );
      result.updates.posterS3Key = archived.key;
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.fields.posterArchived = true;
    } catch (err) {
      console.warn(
        `[yt-comm-enrich] poster archive failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  result.updates.updatedAt = new Date();
  return result;
}
