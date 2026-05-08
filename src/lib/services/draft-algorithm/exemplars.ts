import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import type { PastCaptionExample } from "@/lib/draft-agent";

// Cap on past captions surfaced to the model. The agent picks up tone from
// 3–4 strong exemplars; beyond ~8 we just bloat the prompt without lifting
// quality. Same number the IG path used in the recency-ordered era.
const MAX_PAST_CAPTIONS = 8;

// Freshness floor. Voice on every platform shifts on the order of months —
// a 2024 LinkedIn winner reads stale in 2026. 180 days is the sweet spot:
// recent enough that tone matches today's feed, wide enough that sparse
// brand-platform pairs (e.g. Threads on a small brand) still find exemplars.
// If a pair has nothing in this window we return [] and the agent falls
// through to format-instructions-only.
const FRESHNESS_DAYS = 180;

export interface GetTopPerformingCaptionsArgs {
  brand: string;
  postType: string;
  /** Item to exclude — typically the item being drafted, so we don't echo
   *  its seeded source-body back as an exemplar. */
  excludeId: string;
}

/**
 * Top-performing past captions for the same (brand, post_type), ranked by
 * lifetime views.
 *
 * The previous IG-only path ordered by `published_at DESC` — recency. That
 * works as a fallback signal but it isn't *quality* signal: the most recent
 * post for a format is just the most recent, not the best. For a draft
 * algorithm whose whole job is "match the tone of stuff that worked," views
 * are the better axis. We pair it with a 180-day freshness floor so the
 * exemplars stay in the current voice era.
 */
export async function getTopPerformingCaptions(
  args: GetTopPerformingCaptionsArgs,
): Promise<PastCaptionExample[]> {
  const { brand, postType, excludeId } = args;

  const rows = await db
    .select({
      caption: productionItems.contentBody,
      publishedAt: productionItems.publishedAt,
      publishedLink: productionItems.publishedLink,
      views: productionItems.views,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.postType, postType),
        eq(productionItems.status, "Published"),
        isNotNull(productionItems.contentBody),
        ne(productionItems.id, excludeId),
        sql`length(trim(${productionItems.contentBody})) > 0`,
        sql`${productionItems.publishedAt} > now() - (${FRESHNESS_DAYS} || ' days')::interval`,
      ),
    )
    .orderBy(sql`${productionItems.views} desc nulls last`, desc(productionItems.publishedAt))
    .limit(MAX_PAST_CAPTIONS);

  return rows.map((row) => ({
    caption: row.caption ?? "",
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publishedLink: row.publishedLink ?? null,
    views: row.views ?? null,
  }));
}
