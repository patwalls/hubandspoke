import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveCarouselMedia, type CarouselSlide } from "./shared";
import { PermanentEnrichmentError } from "./errors";
import type { EnrichmentResult } from "./types";

interface ThreadsImageVersion {
  url?: string;
  width?: number;
  height?: number;
}

interface ThreadsUser {
  username?: string;
  full_name?: string;
  is_verified?: boolean;
  follower_count?: number;
}

interface ThreadsPost {
  pk?: string;
  id?: string;
  caption?: { text?: string } | null;
  text_post_app_info?: { direct_reply_count?: number };
  user?: ThreadsUser;
  image_versions2?: { candidates?: ThreadsImageVersion[] };
  carousel_media?: Array<{
    image_versions2?: { candidates?: ThreadsImageVersion[] };
  }>;
  view_counts?: number;
  like_count?: number;
}

interface ThreadsResponse {
  post?: ThreadsPost;
}

const THREADS_HOST_RE = /(^|\.)threads\.(net|com)$/;

export function isThreadsUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return THREADS_HOST_RE.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function pickLargestCandidate(
  candidates: ThreadsImageVersion[] | undefined
): string | null {
  if (!candidates?.length) return null;
  const sorted = [...candidates]
    .filter((c) => c.url)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url ?? null;
}

export async function enrichThreadsItem(
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
  if (!item.publishedLink || !isThreadsUrl(item.publishedLink)) {
    throw new PermanentEnrichmentError(
      `Item ${itemId} is not a Threads URL: ${item.publishedLink ?? "(none)"}`
    );
  }

  const result: EnrichmentResult = {
    updates: {},
    creditsSpent: 0,
    fields: {},
  };

  const data = await scFetchJson<ThreadsResponse>("/v1/threads/post", {
    url: item.publishedLink,
  });
  result.creditsSpent += 1;

  const post = data?.post;
  if (!post) {
    throw new ScrapeCreatorsError(
      `Threads post not found at ${item.publishedLink}`,
      404,
      "/v1/threads/post"
    );
  }

  const body = post.caption?.text;
  if (body && body.trim().length > 0) {
    result.updates.contentBody = body;
    result.updates.contentBodyFetchedAt = new Date();
    result.updates.contentBodySource = "scrape_creators";
    result.fields.captionFetched = true;
  }

  const user = post.user;
  if (user?.username || user?.full_name) {
    result.updates.authorHandle = user.username ?? null;
    result.updates.authorDisplayName = user.full_name ?? null;
    result.updates.authorVerified = user.is_verified ?? null;
    if (typeof user.follower_count === "number") {
      result.updates.authorFollowerCount = user.follower_count;
    }
    result.fields.authorFetched = true;
  }

  // Build a slide list: prefer `carousel_media` (one slide per entry); fall
  // back to the post's own `image_versions2` for single-image posts. All
  // Threads slides are images; the SC schema doesn't expose video versions
  // here.
  const stem = post.pk ?? post.id ?? "thread";
  const slides: CarouselSlide[] = [];
  if (post.carousel_media?.length) {
    for (const entry of post.carousel_media) {
      const url = pickLargestCandidate(entry.image_versions2?.candidates);
      if (url) slides.push({ url, kind: "image", fileNameHint: stem });
    }
  } else {
    const url = pickLargestCandidate(post.image_versions2?.candidates);
    if (url) slides.push({ url, kind: "image", fileNameHint: stem });
  }

  if (slides.length > 0) {
    const res = await archiveCarouselMedia(itemId, slides);
    if (res.primary) {
      // Threads slides are still images — mirror slide 0 into BOTH posterS3Key
      // and mediaS3Key so legacy UI (which reads either) keeps rendering a
      // cover.
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
