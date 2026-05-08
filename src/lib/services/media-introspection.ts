/**
 * Server-only media-related DB queries that don't fit cleanly into
 * `draft-media.ts` (which is bundled to the client because the dropzone
 * imports `validateMediaForPostType` / `dropZoneOptionsForPostType`).
 *
 * Importing `@/lib/db` at module top would pull `postgres` into client
 * bundles and break the build, so server-only DB probes live here instead.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItemMedia } from "@/lib/db/schema";

/**
 * Cheap "does this item have any carousel rows yet?" check. Used by the
 * repost / cross-post route to decide whether to force a `withMedia: true`
 * re-enrichment of the source — see `isVideoBearingPostType` in
 * `platform-media-rules.ts`.
 */
export async function hasAnyCarouselRow(itemId: string): Promise<boolean> {
  const [row] = await db
    .select({ x: sql<number>`1` })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, itemId))
    .limit(1);
  return !!row;
}
