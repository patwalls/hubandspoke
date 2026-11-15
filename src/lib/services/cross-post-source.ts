import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
import { hasAnyCarouselRow } from "@/lib/services/media-introspection";
import { resolveCleanSourceMedia } from "@/lib/services/clean-media-resolver";
import { isVideoBearingPostType } from "@/lib/platform-media-rules";
import { createSourcePreparer } from "@/lib/cross-post-source-preparer";

/**
 * The web dyno's one shared preparer: the cross-post dialog's warm-up call
 * and every parallel cross-post POST for the same source join one
 * enrichment run (see `src/lib/cross-post-source-preparer.ts`).
 */
export const prepareCrossPostSource = createSourcePreparer({
  async loadSource(id) {
    const [row] = await db
      .select({
        id: productionItems.id,
        postType: productionItems.postType,
        mediaS3Key: productionItems.mediaS3Key,
        enrichmentCompletedAt: productionItems.enrichmentCompletedAt,
      })
      .from(productionItems)
      .where(eq(productionItems.id, id))
      .limit(1);
    return row ?? null;
  },
  async hasCleanOriginal(id) {
    return (await resolveCleanSourceMedia(id)).kind === "archived";
  },
  hasCarouselRow: hasAnyCarouselRow,
  isVideoBearing: isVideoBearingPostType,
  enrich: (id, opts) => enrichSingleItem(id, opts),
  logError: (message) => console.error(message),
});
