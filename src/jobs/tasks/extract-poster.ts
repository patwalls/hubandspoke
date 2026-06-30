import type { Task } from "graphile-worker";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { extractPosterFromMediaS3 } from "./poster-extract-pipeline";

export interface ExtractPosterPayload {
  productionItemId: string;
  /** Re-extract even if a poster already exists. Default false. */
  force?: boolean;
}

/** Short-form post types where a frame-0 grab is meaningful — these all
 *  have an editor-designed cover painted onto the first frame. Long-form
 *  YouTube is excluded: its thumbnail is a separate asset that doesn't
 *  match frame 0 of the video. */
const FRAME0_POSTER_POST_TYPES = [
  "instagram_reel",
  "instagram_post",
  "tiktok",
  "youtube_shorts",
];

export const EXTRACT_POSTER_SWEEP_BATCH_LIMIT = 50;

export async function selectExtractPosterCandidates(
  limit: number = EXTRACT_POSTER_SWEEP_BATCH_LIMIT,
): Promise<string[]> {
  const rows = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNull(productionItems.posterS3Key),
        isNotNull(productionItems.mediaS3Key),
        inArray(productionItems.postType, FRAME0_POSTER_POST_TYPES),
      ),
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(limit);

  return rows.map((r) => r.id);
}

/**
 * Per-item poster extraction. For short-form items where enrichment archived
 * a .mp4 but didn't get a `display_url`-derived cover, this pulls the first
 * frame out of the .mp4 and uploads it as a poster. Idempotent on
 * `posterS3Key`: skip when one is already present unless `force=true`.
 *
 * Downstream effect: once `posterS3Key` is set, the next `vision-extract`
 * pass OCRs the on-video burn-in overlay and writes `hook` + `overlay` with
 * `hook_source='vision'`.
 */
export const extractPosterTask: Task = async (rawPayload, helpers) => {
  const { productionItemId, force = false } = rawPayload as ExtractPosterPayload;
  const start = Date.now();
  helpers.logger.info(`extract-poster start item=${productionItemId}`);

  const [item] = await db
    .select({
      id: productionItems.id,
      mediaS3Key: productionItems.mediaS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
      posterS3Key: productionItems.posterS3Key,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    helpers.logger.info(`extract-poster skip item=${productionItemId} reason=not-found`);
    return;
  }
  if (!item.mediaS3Key) {
    helpers.logger.info(`extract-poster skip item=${productionItemId} reason=no-media`);
    return;
  }
  if (item.posterS3Key && !force) {
    helpers.logger.info(
      `extract-poster skip item=${productionItemId} reason=poster-already-set`,
    );
    return;
  }

  const result = await extractPosterFromMediaS3(
    item.mediaS3Key,
    productionItemId,
    { info: (msg) => helpers.logger.info(`extract-poster ${msg}`) },
    item.mediaS3Bucket ?? undefined,
  );

  await db
    .update(productionItems)
    .set({
      posterS3Key: result.posterS3Key,
      mediaS3Bucket: item.mediaS3Bucket ?? result.bucket,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

  helpers.logger.info(
    `extract-poster ok item=${productionItemId} bytes=${result.bytes} (${Date.now() - start}ms)`,
  );
};
