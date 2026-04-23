import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
import { bucketName } from "@/lib/s3";
import { scFetchJson, ScrapeCreatorsError } from "@/lib/services/sc-client";
import {
  archiveCarouselMedia,
  archiveRemoteToS3,
  saveTranscript,
  type CarouselSlide,
} from "./shared";
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

interface IGSidecarNode {
  is_video?: boolean;
  display_url?: string;
  video_url?: string;
}

interface IGSidecarEdge {
  node?: IGSidecarNode;
}

interface IGMedia {
  is_video?: boolean;
  product_type?: string;
  display_url?: string;
  video_url?: string;
  video_duration?: number;
  edge_media_to_caption?: { edges?: IGCaptionEdge[] };
  owner?: IGOwner;
  /** Present on carousel posts. Each edge is a slide with its own
   *  display_url / video_url / is_video. SC's flat `download_media_urls`
   *  array covers videos only, so carousels have to be built from this. */
  edge_sidecar_to_children?: { edges?: IGSidecarEdge[] };
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
  /** Burn 10 credits on the SC-hosted media download. Default false to keep
   *  the auto sweep cheap — transcripts + posters are the high-value training
   *  signals, the raw media is only worth archiving when explicitly opted in
   *  (backfill script's `--with-media`, enrichment dialog's Sync button).
   *  Per-slide idempotency in `archiveCarouselMedia` means a repeat call with
   *  the same upstream URLs doesn't re-download. */
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
  // Gate on `withMedia` only — per-slide idempotency in `archiveCarouselMedia`
  // avoids re-downloading slides we already have, and a re-run is the only
  // way to backfill slides 1..N on items that were enriched pre-carousel.
  const needsMediaArchive = withMedia;
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
  // Step 3: archive primary media + every carousel slide to S3.
  //
  // The shape SC returns depends on the post type:
  //   - Single photo / single video / reel → one entry in
  //     `download_media_urls[]` with a `cdn_url` we can archive directly.
  //   - Carousel (2–10 mixed slides)      → `edge_sidecar_to_children.edges[]`
  //     has one node per slide with its own `display_url` / `video_url` /
  //     `is_video`. SC's `download_media_urls[]` for the same post only
  //     contains the videos (sometimes just the first one), so image
  //     slides are silently dropped if we read the flat list. Build the
  //     slide array from the sidecar instead and fall through to the
  //     flat list only for non-carousel posts.
  //
  // Video slides use the IG CDN `video_url` directly — the URL is fresh at
  // fetch time and `archiveRemoteToS3` downloads it before it rotates.
  // `archiveCarouselMedia` is idempotent by (itemId, index, sourceUrl).
  // ------------------------------------------------------------------
  if (needsMediaArchive) {
    const sidecarEdges = media.edge_sidecar_to_children?.edges ?? [];
    let slides: CarouselSlide[];
    if (sidecarEdges.length > 0) {
      slides = sidecarEdges
        .map((edge): CarouselSlide | null => {
          const n = edge.node;
          if (!n) return null;
          if (n.is_video && n.video_url) {
            return {
              url: n.video_url,
              kind: "video",
              posterUrl: n.display_url,
              fileNameHint: shortcode,
            };
          }
          if (!n.is_video && n.display_url) {
            return {
              url: n.display_url,
              kind: "image",
              fileNameHint: shortcode,
            };
          }
          return null;
        })
        .filter((s): s is CarouselSlide => !!s);
    } else {
      slides = (data.download_media_urls ?? [])
        .filter((e): e is IGDownloadEntry & { cdn_url: string } => !!e.cdn_url)
        .map((e) => ({
          url: e.cdn_url,
          kind: e.type === "video" ? "video" : "image",
          fileNameHint: shortcode,
        }));
    }
    if (slides.length > 0) {
      const res = await archiveCarouselMedia(itemId, slides);
      if (res.primary) {
        result.updates.mediaS3Bucket = item.mediaS3Bucket ?? bucketName();
        result.updates.mediaS3Key = res.primary.key;
        result.updates.mediaS3UploadedAt = new Date();
        result.updates.mediaSizeBytes = res.primary.size;
        result.updates.mediaContentType = res.primary.contentType;
        // The ephemeral URL is now stale data — clear it.
        result.updates.contentMediaUrl = null;
        result.fields.mediaArchived = res.archived > 0;
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
