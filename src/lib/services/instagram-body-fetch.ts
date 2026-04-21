import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { SC_BASE, headers as scHeaders } from "@/lib/services/matg-sync";
import { buildKey, bucketName, putObject } from "@/lib/s3";

export class InstagramBodyFetchError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "not_found"
      | "no_link"
      | "not_an_instagram_url"
      | "upstream_missing"
      | "empty_caption"
      | "media_too_large"
      | "unknown"
  ) {
    super(message);
    this.name = "InstagramBodyFetchError";
  }
}

const IG_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);

// Matches /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>
const IG_PATH_RE = /^\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?/;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024; // 200 MB defensive cap

export function isInstagramUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!IG_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    return IG_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

function shortcodeFromUrl(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(
      /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/
    );
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function contentTypeFor(url: string): string {
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

function extFromContentType(ct: string): string {
  if (ct.startsWith("video/mp4")) return "mp4";
  if (ct === "video/quicktime") return "mov";
  if (ct === "image/png") return "png";
  if (ct === "image/webp") return "webp";
  return "jpg";
}

export interface InstagramBodyFetchResult {
  productionItemId: string;
  contentBody: string | null;
  contentMediaUrl: string | null;
  mediaS3Key: string | null;
  mediaSizeBytes: number | null;
  fetchedAt: Date;
}

interface IGCaptionEdge {
  node?: { text?: string };
}

interface IGMedia {
  is_video?: boolean;
  product_type?: string;
  display_url?: string;
  video_url?: string;
  edge_media_to_caption?: { edges?: IGCaptionEdge[] };
}

interface IGDownloadEntry {
  post_id?: string;
  cdn_url?: string;
  type?: "image" | "video" | string;
  cached?: boolean;
}

interface IGResponse {
  data?: { xdt_shortcode_media?: IGMedia };
  // Array of { post_id, cdn_url, type } objects. For carousels, one entry per
  // child. For single-media posts, a single entry.
  download_media_urls?: IGDownloadEntry[];
}

// Pick the "best" media entry to archive. For carousels, we archive the
// first — same as IG's cover selection. Callers that need every child of a
// carousel should loop over the full array instead.
function pickArchiveUrl(entries: IGDownloadEntry[] | undefined): string | null {
  const first = entries?.[0];
  return first?.cdn_url ?? null;
}

function extractCaption(media: IGMedia | undefined): string | null {
  const text = media?.edge_media_to_caption?.edges?.[0]?.node?.text;
  return text && text.length > 0 ? text : null;
}

// Downloads a remote URL and puts it in S3 under a key tied to the item. Returns
// the key, content type, and byte length. Throws on download or upload failure.
async function archiveRemoteMediaToS3(
  productionItemId: string,
  remoteUrl: string,
  fileNameHint: string
): Promise<{ key: string; size: number; contentType: string }> {
  const res = await fetch(remoteUrl);
  if (!res.ok) {
    throw new Error(
      `Failed to download media from ${remoteUrl}: ${res.status}`
    );
  }
  const headerLen = Number(res.headers.get("content-length") ?? 0);
  if (headerLen && headerLen > MAX_MEDIA_BYTES) {
    throw new InstagramBodyFetchError(
      `Media is ${headerLen} bytes — above ${MAX_MEDIA_BYTES} limit`,
      "media_too_large"
    );
  }
  const arr = await res.arrayBuffer();
  if (arr.byteLength > MAX_MEDIA_BYTES) {
    throw new InstagramBodyFetchError(
      `Media is ${arr.byteLength} bytes — above ${MAX_MEDIA_BYTES} limit`,
      "media_too_large"
    );
  }
  const contentType =
    res.headers.get("content-type") ?? contentTypeFor(remoteUrl);
  const ext = extFromContentType(contentType);
  const safeName = fileNameHint.endsWith(`.${ext}`)
    ? fileNameHint
    : `${fileNameHint}.${ext}`;
  const key = buildKey(productionItemId, safeName);
  await putObject(key, Buffer.from(arr), contentType);
  return { key, size: arr.byteLength, contentType };
}

export async function fetchInstagramBody(
  productionItemId: string,
  options: { withMedia?: boolean } = {}
): Promise<InstagramBodyFetchResult> {
  const startedAt = new Date();

  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      mediaS3Key: productionItems.mediaS3Key,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    throw new InstagramBodyFetchError(
      `Production item ${productionItemId} not found`,
      "not_found"
    );
  }
  if (!item.publishedLink) {
    throw new InstagramBodyFetchError("Item has no published_link", "no_link");
  }
  if (!isInstagramUrl(item.publishedLink)) {
    throw new InstagramBodyFetchError(
      `published_link is not an Instagram URL: ${item.publishedLink}`,
      "not_an_instagram_url"
    );
  }

  // Idempotency: if we've already archived media for this item, skip the
  // 10-credit download path regardless of what the caller asked for.
  const shouldDownloadMedia =
    Boolean(options.withMedia) && !item.mediaS3Key;

  try {
    const q = new URLSearchParams({ url: item.publishedLink });
    if (shouldDownloadMedia) q.set("download_media", "true");
    const res = await fetch(`${SC_BASE}/v1/instagram/post?${q.toString()}`, {
      headers: scHeaders(),
    });
    if (!res.ok) {
      throw new InstagramBodyFetchError(
        `ScrapeCreators IG post error ${res.status}: ${await res.text()}`,
        "upstream_missing"
      );
    }
    const data = (await res.json()) as IGResponse;
    const media = data?.data?.xdt_shortcode_media;
    if (!media) {
      throw new InstagramBodyFetchError(
        `ScrapeCreators returned no media for ${item.publishedLink}`,
        "upstream_missing"
      );
    }
    const caption = extractCaption(media);
    const ephemeralMedia = media.video_url ?? media.display_url ?? null;

    // Try to archive the SC-hosted permanent media into our S3. If anything
    // in this block fails, we still write the caption below — we just fall
    // back to storing the ephemeral IG CDN URL in content_media_url.
    let s3Archived: {
      key: string;
      size: number;
      contentType: string;
    } | null = null;
    let archiveError: string | null = null;
    if (shouldDownloadMedia) {
      const scHosted = pickArchiveUrl(data.download_media_urls);
      if (scHosted) {
        try {
          const shortcode = shortcodeFromUrl(item.publishedLink) ?? "media";
          s3Archived = await archiveRemoteMediaToS3(
            productionItemId,
            scHosted,
            shortcode
          );
        } catch (err) {
          archiveError = err instanceof Error ? err.message : String(err);
          // Swallow — fall through to writing caption + ephemeral URL.
        }
      }
    }

    const fetchedAt = new Date();
    const updates: Record<string, unknown> = { updatedAt: fetchedAt };
    if (caption) {
      updates.contentBody = caption;
      updates.contentBodyFetchedAt = fetchedAt;
      updates.contentBodySource = "scrape_creators";
    }
    if (s3Archived) {
      updates.mediaS3Bucket = bucketName();
      updates.mediaS3Key = s3Archived.key;
      updates.mediaS3UploadedAt = fetchedAt;
      updates.mediaSizeBytes = s3Archived.size;
      updates.mediaContentType = s3Archived.contentType;
      // Clear the ephemeral URL — the durable pointer is now mediaS3Key.
      updates.contentMediaUrl = null;
    } else if (ephemeralMedia) {
      updates.contentMediaUrl = ephemeralMedia;
    }

    if (Object.keys(updates).length > 1) {
      await db
        .update(productionItems)
        .set(updates)
        .where(eq(productionItems.id, productionItemId));
    }

    await db.insert(syncLogs).values({
      syncType: shouldDownloadMedia
        ? "instagram-body-fetch-with-media"
        : "instagram-body-fetch",
      status: archiveError ? "partial" : "success",
      itemsUpdated: 1,
      errorMessage: archiveError,
      startedAt,
      completedAt: new Date(),
    });

    return {
      productionItemId,
      contentBody: caption,
      contentMediaUrl: s3Archived ? null : ephemeralMedia,
      mediaS3Key: s3Archived?.key ?? null,
      mediaSizeBytes: s3Archived?.size ?? null,
      fetchedAt,
    };
  } catch (err) {
    await db.insert(syncLogs).values({
      syncType: options.withMedia
        ? "instagram-body-fetch-with-media"
        : "instagram-body-fetch",
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }
}
