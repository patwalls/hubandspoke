import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { SC_BASE, headers as scHeaders } from "@/lib/services/matg-sync";

export class InstagramBodyFetchError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "not_found"
      | "no_link"
      | "not_an_instagram_url"
      | "upstream_missing"
      | "empty_caption"
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

export interface InstagramBodyFetchResult {
  productionItemId: string;
  contentBody: string | null;
  contentMediaUrl: string | null;
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

interface IGResponse {
  data?: { xdt_shortcode_media?: IGMedia };
  download_media_urls?: string[];
}

function extractCaption(media: IGMedia | undefined): string | null {
  const text = media?.edge_media_to_caption?.edges?.[0]?.node?.text;
  return text && text.length > 0 ? text : null;
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

  try {
    const q = new URLSearchParams({ url: item.publishedLink });
    if (options.withMedia) q.set("download_media", "true");
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
    // Prefer the permanent SC-hosted URL when we asked for media download;
    // fall back to IG's CDN URL (expires, but better than nothing).
    const archivedMedia = options.withMedia
      ? data.download_media_urls?.[0] ?? null
      : null;
    const ephemeralMedia = media.video_url ?? media.display_url ?? null;
    const contentMediaUrl = archivedMedia ?? ephemeralMedia;

    const fetchedAt = new Date();
    const updates: Record<string, unknown> = {
      updatedAt: fetchedAt,
    };
    if (caption) {
      updates.contentBody = caption;
      updates.contentBodyFetchedAt = fetchedAt;
      updates.contentBodySource = "scrape_creators";
    }
    if (contentMediaUrl) {
      updates.contentMediaUrl = contentMediaUrl;
    }

    if (Object.keys(updates).length > 1) {
      await db
        .update(productionItems)
        .set(updates)
        .where(eq(productionItems.id, productionItemId));
    }

    await db.insert(syncLogs).values({
      syncType: options.withMedia
        ? "instagram-body-fetch-with-media"
        : "instagram-body-fetch",
      status: "success",
      itemsUpdated: 1,
      startedAt,
      completedAt: new Date(),
    });

    return {
      productionItemId,
      contentBody: caption,
      contentMediaUrl,
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
