/**
 * Compatibility shim — the on-demand IG fetch route still imports
 * `fetchInstagramBody` and `InstagramBodyFetchError` from this file. The
 * actual logic lives in `enrichment/instagram.ts` now; this file just adapts
 * the enricher's shape to the route's expected response and persists.
 *
 * New code should call `enrichInstagramItem` directly.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import {
  enrichInstagramItem,
  isInstagramUrl,
} from "@/lib/services/enrichment/instagram";
import { ScrapeCreatorsError } from "@/lib/services/sc-client";

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

export { isInstagramUrl };

export interface InstagramBodyFetchResult {
  productionItemId: string;
  contentBody: string | null;
  contentMediaUrl: string | null;
  mediaS3Key: string | null;
  mediaSizeBytes: number | null;
  posterS3Key: string | null;
  fetchedAt: Date;
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
    const result = await enrichInstagramItem(productionItemId, {
      withMedia: options.withMedia,
    });

    const fetchedAt = new Date();
    const updates: Record<string, unknown> = {
      ...result.updates,
      enrichmentCompletedAt: fetchedAt,
      enrichmentError: null,
    };

    if (Object.keys(updates).length > 0) {
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
      contentBody: (updates.contentBody as string | null | undefined) ?? null,
      contentMediaUrl:
        (updates.contentMediaUrl as string | null | undefined) ?? null,
      mediaS3Key: (updates.mediaS3Key as string | null | undefined) ?? null,
      mediaSizeBytes:
        (updates.mediaSizeBytes as number | null | undefined) ?? null,
      posterS3Key: (updates.posterS3Key as string | null | undefined) ?? null,
      fetchedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(syncLogs).values({
      syncType: options.withMedia
        ? "instagram-body-fetch-with-media"
        : "instagram-body-fetch",
      status: "error",
      errorMessage: message,
      startedAt,
      completedAt: new Date(),
    });

    if (err instanceof InstagramBodyFetchError) throw err;
    if (err instanceof ScrapeCreatorsError) {
      throw new InstagramBodyFetchError(message, "upstream_missing");
    }
    throw new InstagramBodyFetchError(message, "unknown");
  }
}
