import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveCarouselMedia, type CarouselSlide } from "./shared";
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

  // Visibility log: when SC returns NOTHING for the short-form body
  // fields, the draft algorithm has to fall back to `description` /
  // `title` as substrate. The fallback works (see draft-algorithm/run.ts
  // v1.4 substrate chain) but we want to know how often SC under-reports
  // here so we can tell SC vs LinkedIn vs our enricher apart.
  const hadAnyBodyField =
    !!data.text || !!data.bodyText || !!data.postBody || !!data.headline;
  if (!hadAnyBodyField) {
    console.info(
      `linkedin enrichment: SC returned no short-form body fields for ${item.publishedLink}; description=${data.description ? "present" : "empty"}`,
    );
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

  // Treat every entry in `data.images` as a distinct slide — LinkedIn multi-
  // image posts expose one entry per slide. Fall back to the top-level
  // thumbnail when `images` is missing entirely. If `images` really turns out
  // to be "multiple sizes of the same image" for some post types, the
  // idempotency check in archiveCarouselMedia will still produce a correct
  // (if slightly redundant) result.
  const stem = postIdFromUrl(item.publishedLink);
  const slides: CarouselSlide[] = [];
  if (data.images?.length) {
    for (const img of data.images) {
      if (img.url) slides.push({ url: img.url, kind: "image", fileNameHint: stem });
    }
  } else {
    const fallback = data.thumbnail ?? data.thumbnailUrl;
    if (fallback) slides.push({ url: fallback, kind: "image", fileNameHint: stem });
  }

  // v1.4: when SC returns no images AND no thumbnail, try the post URL's
  // Open Graph tag as a last resort. LinkedIn share pages serve og:image
  // publicly; SC under-reports media for some post variants so this
  // closes the gap. Best-effort: 5s timeout, never throws — image is
  // always optional.
  if (slides.length === 0) {
    const ogImage = await fetchOpenGraphImage(item.publishedLink).catch(
      (err) => {
        console.warn(
          `linkedin enrichment: og:image fallback failed for ${item.publishedLink}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      },
    );
    if (ogImage) {
      slides.push({ url: ogImage, kind: "image", fileNameHint: stem });
      console.info(
        `linkedin enrichment: og:image fallback resolved for ${item.publishedLink}`,
      );
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

function lastPathSegment(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? null;
  } catch {
    return null;
  }
}

const OG_FETCH_TIMEOUT_MS = 5_000;
const OG_USER_AGENT =
  // Pretend to be a generic crawler — LinkedIn serves OG tags to crawlers
  // even on share URLs that block normal Mozilla UAs.
  "Mozilla/5.0 (compatible; HubAndSpokeBot/1.0; +https://hubandspoke.starterstory.com)";

/** Fetch the page at `url` and parse `<meta property="og:image">` (or
 *  `og:image:secure_url`) from the head. Returns the image URL or null
 *  on miss. Capped at 5s; only the first ~64 KB are read so we don't
 *  pull a whole HTML body for one tag. */
async function fetchOpenGraphImage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": OG_USER_AGENT,
        Accept: "text/html",
      },
      redirect: "follow",
    });
    if (!res.ok || !res.body) return null;
    // Read only the first ~64 KB — meta tags live in <head> early on.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const limit = 64 * 1024;
    while (total < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    reader.cancel().catch(() => {});
    const head = new TextDecoder().decode(
      chunks.length === 1
        ? chunks[0]
        : Buffer.concat(chunks.map((c) => Buffer.from(c))),
    );
    const match =
      head.match(
        /<meta\s+property=["']og:image:secure_url["']\s+content=["']([^"']+)["']/i,
      ) ??
      head.match(
        /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
      ) ??
      head.match(
        /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
      );
    return match?.[1] ?? null;
  } finally {
    clearTimeout(timer);
  }
}
