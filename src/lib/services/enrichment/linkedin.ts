import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveRemoteToS3 } from "./shared";
import type { EnrichmentResult } from "./types";

interface LIAuthor {
  name?: string;
  url?: string;
  followerCount?: number;
  isVerified?: boolean;
  username?: string;
}

interface LIImage {
  url?: string;
  width?: number;
  height?: number;
}

interface LIPostResponse {
  success?: boolean;
  url?: string;
  name?: string;
  headline?: string;
  description?: string;
  text?: string;
  bodyText?: string;
  postBody?: string;
  datePublished?: string;
  author?: LIAuthor;
  images?: LIImage[];
  thumbnail?: string;
  thumbnailUrl?: string;
}

const LI_HOST_RE = /(^|\.)linkedin\.com$/;

export function isLinkedInUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return LI_HOST_RE.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function pickLargest(images: LIImage[] | undefined): string | null {
  if (!images?.length) return null;
  const withSize = images.filter((i) => i.url);
  if (!withSize.length) return null;
  withSize.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return withSize[0].url ?? null;
}

function postIdFromUrl(url: string): string {
  try {
    const m = new URL(url).pathname.match(/(\d{15,})/);
    return m?.[1] ?? "post";
  } catch {
    return "post";
  }
}

export async function enrichLinkedInItem(
  itemId: string
): Promise<EnrichmentResult> {
  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      contentBody: productionItems.contentBody,
      description: productionItems.description,
      posterS3Key: productionItems.posterS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);
  if (!item.publishedLink || !isLinkedInUrl(item.publishedLink)) {
    throw new Error(
      `Item ${itemId} is not a LinkedIn URL: ${item.publishedLink ?? "(none)"}`
    );
  }

  const result: EnrichmentResult = {
    updates: {},
    creditsSpent: 0,
    fields: {},
  };

  const data = await scFetchJson<LIPostResponse>("/v1/linkedin/post", {
    url: item.publishedLink,
  });
  result.creditsSpent += 1;

  if (!data || data.success === false) {
    throw new ScrapeCreatorsError(
      `LinkedIn post not found at ${item.publishedLink}`,
      404,
      "/v1/linkedin/post"
    );
  }

  // SC's LinkedIn payload has a few possible body field names depending on
  // the post type (article vs share vs newsletter). Try them in order.
  const body = data.text ?? data.bodyText ?? data.postBody ?? data.headline;
  if (body && body.trim().length > 0) {
    result.updates.contentBody = body;
    result.updates.contentBodyFetchedAt = new Date();
    result.updates.contentBodySource = "scrape_creators";
    result.fields.captionFetched = true;
  }

  // Description field is for the longer-form expanded preview text — distinct
  // from the short post body above.
  if (data.description && data.description !== item.description) {
    result.updates.description = data.description;
    result.fields.descriptionFetched = true;
  }

  const author = data.author;
  if (author?.name || author?.username) {
    result.updates.authorHandle =
      author.username ?? (author.url ? lastPathSegment(author.url) : null);
    result.updates.authorDisplayName = author.name ?? null;
    result.updates.authorVerified = author.isVerified ?? null;
    if (typeof author.followerCount === "number") {
      result.updates.authorFollowerCount = author.followerCount;
    }
    result.fields.authorFetched = true;
  }

  const imageUrl =
    pickLargest(data.images) ??
    data.thumbnail ??
    data.thumbnailUrl ??
    null;
  if (!item.posterS3Key && imageUrl) {
    try {
      const archived = await archiveRemoteToS3(
        itemId,
        imageUrl,
        `${postIdFromUrl(item.publishedLink)}-poster`
      );
      result.updates.posterS3Key = archived.key;
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.fields.posterArchived = true;
    } catch (err) {
      console.warn(
        `[linkedin-enrich] poster archive failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  result.updates.updatedAt = new Date();
  return result;
}

function lastPathSegment(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? null;
  } catch {
    return null;
  }
}
