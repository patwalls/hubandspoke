/**
 * Images the design can use, without uploads: the source video's own
 * pictures (its poster frame, its platform thumbnail, any archived image
 * media) plus the brand's wordmark. Each comes with a browser-loadable
 * preview URL; the doc stores the durable source.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItemMedia, productionItems } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import type { DesignImageSource } from "@/lib/design-editor/doc";

import { BRAND_WORDMARKS, type ImageCandidate } from "@/lib/design-editor/brand-assets";

export { BRAND_WORDMARKS, type ImageCandidate };

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

export async function previewUrlFor(src: DesignImageSource): Promise<string> {
  if (src.kind === "url") return src.url;
  if (src.kind === "asset") return src.path;
  return getPresignedGetUrl(src.key, 4 * 3600, { bucket: src.bucket ?? undefined });
}

/** "https://www.youtube.com/watch?v=ID" / youtu.be/ID / shorts/ID → ID. */
export function youtubeIdFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

/** The YouTube thumbnail for a source item, from its id or URL. */
export async function youtubeThumbnailFor(sourceItemId: string): Promise<ImageCandidate | null> {
  const [item] = await db.select({ youtubeId: productionItems.youtubeId, youtubeUrl: productionItems.youtubeUrl, thumbnail: productionItems.thumbnail }).from(productionItems).where(eq(productionItems.id, sourceItemId)).limit(1);
  if (!item) return null;
  const id = item.youtubeId ?? youtubeIdFrom(item.youtubeUrl);
  const url = id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : item.thumbnail && /^https?:\/\//.test(item.thumbnail) ? item.thumbnail : null;
  return url ? { label: "YouTube thumbnail", src: { kind: "url", url }, previewUrl: url } : null;
}

/** Pictures of the source video, best first. */
export async function sourceImageCandidates(sourceItemId: string): Promise<ImageCandidate[]> {
  const [item] = await db
    .select({
      thumbnail: productionItems.thumbnail,
      posterS3Key: productionItems.posterS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
    })
    .from(productionItems)
    .where(eq(productionItems.id, sourceItemId))
    .limit(1);
  const out: ImageCandidate[] = [];
  if (!item) return out;
  // `poster_s3_key` is mirrored from media and can fall back to the VIDEO key
  // itself — only trust it when it's an image file.
  if (item.posterS3Key && IMAGE_EXT.test(item.posterS3Key)) {
    const src: DesignImageSource = { kind: "s3", bucket: item.mediaS3Bucket, key: item.posterS3Key };
    out.push({ label: "Video frame", src, previewUrl: await previewUrlFor(src) });
  }
  if (item.thumbnail && /^https?:\/\//.test(item.thumbnail)) {
    out.push({ label: "Thumbnail", src: { kind: "url", url: item.thumbnail }, previewUrl: item.thumbnail });
  }
  const media = await db
    .select({ s3Bucket: productionItemMedia.s3Bucket, s3Key: productionItemMedia.s3Key, index: productionItemMedia.index })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, sourceItemId))
    .orderBy(asc(productionItemMedia.index));
  for (const m of media) {
    if (!IMAGE_EXT.test(m.s3Key)) continue;
    const src: DesignImageSource = { kind: "s3", bucket: m.s3Bucket, key: m.s3Key };
    out.push({ label: `Image ${m.index + 1}`, src, previewUrl: await previewUrlFor(src) });
  }
  return out;
}
