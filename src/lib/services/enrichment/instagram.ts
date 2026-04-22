import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import { archiveRemoteToS3, saveTranscript } from "./shared";
import type { EnrichmentResult } from "./types";

const IG_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);
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

interface IGOwner {
  username?: string;
  full_name?: string;
  is_verified?: boolean;
  edge_followed_by?: { count?: number };
}

interface IGCaptionEdge {
  node?: { text?: string };
}

interface IGMedia {
  is_video?: boolean;
  product_type?: string;
  display_url?: string;
  video_url?: string;
  video_duration?: number;
  edge_media_to_caption?: { edges?: IGCaptionEdge[] };
  owner?: IGOwner;
}

interface IGDownloadEntry {
  post_id?: string;
  cdn_url?: string;
  type?: "image" | "video" | string;
}

interface IGPostResponse {
  data?: { xdt_shortcode_media?: IGMedia };
  download_media_urls?: IGDownloadEntry[];
}

interface IGTranscriptEntry {
  id?: string;
  shortcode?: string;
  text?: string | null;
}

interface IGTranscriptResponse {
  success?: boolean;
  transcripts?: IGTranscriptEntry[];
}

function captionFrom(media: IGMedia | undefined): string | null {
  const text = media?.edge_media_to_caption?.edges?.[0]?.node?.text;
  return text && text.length > 0 ? text : null;
}

interface EnrichOptions {
  /** Burn 10 credits on the SC-hosted media download. Skipped automatically
   *  if the item already has `mediaS3Key`. Default false to keep the auto
   *  sweep cheap — transcripts + posters are the high-value training signals,
   *  the raw video is only worth archiving when explicitly opted in (e.g.
   *  via the backfill script's `--with-media` flag). */
  withMedia?: boolean;
}

/**
 * Pull every durable signal SC has for an Instagram item — caption, durable
 * cover image, primary media archive, transcript (if a reel under 2 min),
 * author snapshot — and return the column updates the orchestrator should
 * persist. Per-field idempotency means partial re-runs only fetch what's
 * still missing.
 */
export async function enrichInstagramItem(
  itemId: string,
  options: EnrichOptions = {}
): Promise<EnrichmentResult> {
  const withMedia = options.withMedia ?? false;

  const [item] = await db
    .select({
      id: productionItems.id,
      publishedLink: productionItems.publishedLink,
      contentBody: productionItems.contentBody,
      mediaS3Key: productionItems.mediaS3Key,
      posterS3Key: productionItems.posterS3Key,
      authorHandle: productionItems.authorHandle,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);
  if (!item.publishedLink) throw new Error(`Item ${itemId} has no published_link`);
  if (!isInstagramUrl(item.publishedLink)) {
    throw new Error(
      `Item ${itemId} published_link is not Instagram: ${item.publishedLink}`
    );
  }

  const result: EnrichmentResult = {
    updates: {},
    creditsSpent: 0,
    fields: {},
  };

  // Pre-existing transcript? Skip the transcript SC call later. Cheap select.
  const [existingTranscript] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, itemId))
    .limit(1);

  // ------------------------------------------------------------------
  // Step 1: /v1/instagram/post — caption, display_url, owner. 1 credit.
  // download_media=true bumps to 10 credits and adds SC-hosted CDN URLs;
  // only worth it when we still need to archive the primary media.
  // ------------------------------------------------------------------
  const needsMediaArchive = withMedia && !item.mediaS3Key;
  const query: Record<string, string> = { url: item.publishedLink };
  if (needsMediaArchive) query.download_media = "true";

  const data = await scFetchJson<IGPostResponse>("/v1/instagram/post", query);
  result.creditsSpent += needsMediaArchive ? 10 : 1;

  if (!data) {
    throw new ScrapeCreatorsError(
      `IG post not found at ${item.publishedLink}`,
      404,
      "/v1/instagram/post"
    );
  }
  const media = data.data?.xdt_shortcode_media;
  if (!media) {
    throw new ScrapeCreatorsError(
      `IG post missing xdt_shortcode_media at ${item.publishedLink}`,
      502,
      "/v1/instagram/post"
    );
  }

  // Caption — overwrite if SC has one (captions can be edited upstream).
  const caption = captionFrom(media);
  if (caption) {
    result.updates.contentBody = caption;
    result.updates.contentBodyFetchedAt = new Date();
    result.updates.contentBodySource = "scrape_creators";
    result.fields.captionFetched = true;
  }

  // Author snapshot — record once per enrichment run; harmless to overwrite.
  const owner = media.owner;
  if (owner?.username) {
    result.updates.authorHandle = owner.username;
    result.updates.authorDisplayName = owner.full_name ?? null;
    result.updates.authorVerified = owner.is_verified ?? null;
    if (typeof owner.edge_followed_by?.count === "number") {
      result.updates.authorFollowerCount = owner.edge_followed_by.count;
    }
    result.fields.authorFetched = true;
  }

  const shortcode = shortcodeFromUrl(item.publishedLink) ?? "media";

  // ------------------------------------------------------------------
  // Step 2: archive durable cover image to S3. The fix for the broken
  // thumbnail — display_url is an IG CDN URL that expires within hours,
  // so we copy it into our bucket immediately while the URL is still
  // valid. Idempotent — skip if we already have one.
  // ------------------------------------------------------------------
  if (!item.posterS3Key && media.display_url) {
    try {
      const archived = await archiveRemoteToS3(
        itemId,
        media.display_url,
        `${shortcode}-poster`
      );
      result.updates.posterS3Key = archived.key;
      result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
      result.fields.posterArchived = true;
    } catch (err) {
      // Poster archive is best-effort — don't fail the whole enrichment.
      // The orchestrator's enrichmentError column captures upstream issues
      // when nothing succeeds; per-field misses are silent.
      console.warn(
        `[ig-enrich] poster archive failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // ------------------------------------------------------------------
  // Step 3: archive primary media (video for reel, image for photo) to S3.
  // ------------------------------------------------------------------
  if (needsMediaArchive) {
    const scHosted = data.download_media_urls?.[0]?.cdn_url;
    if (scHosted) {
      try {
        const archived = await archiveRemoteToS3(
          itemId,
          scHosted,
          shortcode
        );
        result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
        result.updates.mediaS3Key = archived.key;
        result.updates.mediaS3UploadedAt = new Date();
        result.updates.mediaSizeBytes = archived.size;
        result.updates.mediaContentType = archived.contentType;
        // The ephemeral URL is now stale data — clear it.
        result.updates.contentMediaUrl = null;
        result.fields.mediaArchived = true;
      } catch (err) {
        console.warn(
          `[ig-enrich] media archive failed for ${itemId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 4: transcript (reels under 2 min only — the SC endpoint silently
  // returns null text for longer videos or for non-video posts). 1 credit.
  // ------------------------------------------------------------------
  const isReel =
    media.is_video === true || media.product_type === "clips";
  if (isReel && !existingTranscript) {
    try {
      const transcriptData = await scFetchJson<IGTranscriptResponse>(
        "/v2/instagram/media/transcript",
        { url: item.publishedLink }
      );
      result.creditsSpent += 1;
      const text = transcriptData?.transcripts?.[0]?.text;
      if (text && text.trim().length > 0) {
        await saveTranscript(itemId, {
          source: "scrape_creators_instagram",
          fullText: text,
          durationSec: media.video_duration,
        });
        result.fields.transcriptFetched = true;
      }
    } catch (err) {
      console.warn(
        `[ig-enrich] transcript fetch failed for ${itemId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  result.updates.updatedAt = new Date();
  return result;
}
