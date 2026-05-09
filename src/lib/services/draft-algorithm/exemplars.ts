import { and, desc, eq, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import type { PastCaptionExample } from "@/lib/draft-agent";

// Cap on past captions surfaced to the model. The agent picks up tone from
// 3–4 strong exemplars; beyond ~8 we just bloat the prompt without lifting
// quality. Same number the IG path used in the recency-ordered era.
const MAX_PAST_CAPTIONS = 8;

// Below this many format-scoped matches we top up with platform-scoped rows
// so a sparse / brand-new format doesn't strand the agent with one or two
// examples. 5 is a guess — enough for the LLM to pattern-match a recurring
// structure when the format is mature, low enough that we don't gate every
// brand-new format off entirely.
const MIN_FORMAT_EXAMPLES_BEFORE_TOPUP = 5;

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
  /** When set, format-scoped exemplars are pulled first; if fewer than
   *  MIN_FORMAT_EXAMPLES_BEFORE_TOPUP, the bag is topped up to
   *  MAX_PAST_CAPTIONS with platform-scoped rows. Null/undefined → behaves
   *  exactly like v1.1 (platform-scoped only). */
  format?: string | null;
  /** Item to exclude — typically the item being drafted, so we don't echo
   *  its seeded source-body back as an exemplar. */
  excludeId: string;
}

/**
 * Top-performing past captions for the same (brand, post_type), ranked by
 * lifetime views.
 *
 * v1.2: when `format` is supplied, the function first pulls exemplars whose
 * `productionItems.format` matches case-insensitively — these are the
 * structural template the LLM should mirror. The whole premise of formats is
 * that recurring structure (timestamp breakdowns, listicle openers, etc.)
 * lives at the format level, so exposing only same-format winners is the
 * cleanest way to teach the agent that pattern. If a format is too sparse
 * (< MIN_FORMAT_EXAMPLES_BEFORE_TOPUP rows), we top up with platform-scoped
 * rows so a brand-new format still gets a usable voice/tone reference. The
 * two groups are tagged via the `source` discriminator so the prompt
 * builder can label them honestly (format-canonical vs platform-only).
 */
export async function getTopPerformingCaptions(
  args: GetTopPerformingCaptionsArgs,
): Promise<PastCaptionExample[]> {
  const { brand, postType, format, excludeId } = args;

  const baseFilters = [
    eq(productionItems.brand, brand),
    eq(productionItems.postType, postType),
    eq(productionItems.status, "Published"),
    isNotNull(productionItems.contentBody),
    ne(productionItems.id, excludeId),
    sql`length(trim(${productionItems.contentBody})) > 0`,
    sql`${productionItems.publishedAt} > now() - (${FRESHNESS_DAYS} || ' days')::interval`,
  ];

  // No format on the item → no meaningful "format" vs "platform" split.
  // Behave exactly like v1.1: top 8 brand+postType winners, all tagged
  // platform so the prompt builder renders a single platform-only block.
  if (!format) {
    const rows = await db
      .select({
        caption: productionItems.contentBody,
        publishedAt: productionItems.publishedAt,
        publishedLink: productionItems.publishedLink,
        views: productionItems.views,
      })
      .from(productionItems)
      .where(and(...baseFilters))
      .orderBy(
        sql`${productionItems.views} desc nulls last`,
        desc(productionItems.publishedAt),
      )
      .limit(MAX_PAST_CAPTIONS);
    return rows.map((row) => ({
      caption: row.caption ?? "",
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      publishedLink: row.publishedLink ?? null,
      views: row.views ?? null,
      source: "platform",
    }));
  }

  // Case-insensitive format match — same idiom used by
  // src/app/api/production-items/[id]/repurpose/route.ts to dedup against
  // existing derivatives. Mirrors `formats.uniq_formats_brand_name_lower`.
  const formatRows = await db
    .select({
      id: productionItems.id,
      caption: productionItems.contentBody,
      publishedAt: productionItems.publishedAt,
      publishedLink: productionItems.publishedLink,
      views: productionItems.views,
    })
    .from(productionItems)
    .where(
      and(
        ...baseFilters,
        sql`lower(${productionItems.format}) = lower(${format})`,
      ),
    )
    .orderBy(
      sql`${productionItems.views} desc nulls last`,
      desc(productionItems.publishedAt),
    )
    .limit(MAX_PAST_CAPTIONS);

  const formatExamples: PastCaptionExample[] = formatRows.map((row) => ({
    caption: row.caption ?? "",
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publishedLink: row.publishedLink ?? null,
    views: row.views ?? null,
    source: "format",
  }));

  // Top-up branch: only fires when format-scoping returned a thin set.
  // Pulls v1.1's exact query (brand + post_type, no format filter) but
  // excludes ids already returned in the format query so we don't double-
  // surface the same row.
  if (formatExamples.length >= MIN_FORMAT_EXAMPLES_BEFORE_TOPUP) {
    return formatExamples;
  }

  const remainingSlots = MAX_PAST_CAPTIONS - formatExamples.length;
  const excludedIds = formatRows.map((r) => r.id);

  const platformRows = await db
    .select({
      caption: productionItems.contentBody,
      publishedAt: productionItems.publishedAt,
      publishedLink: productionItems.publishedLink,
      views: productionItems.views,
    })
    .from(productionItems)
    .where(
      and(
        ...baseFilters,
        excludedIds.length > 0
          ? notInArray(productionItems.id, excludedIds)
          : sql`true`,
      ),
    )
    .orderBy(
      sql`${productionItems.views} desc nulls last`,
      desc(productionItems.publishedAt),
    )
    .limit(remainingSlots);

  const platformExamples: PastCaptionExample[] = platformRows.map((row) => ({
    caption: row.caption ?? "",
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publishedLink: row.publishedLink ?? null,
    views: row.views ?? null,
    source: "platform",
  }));

  return [...formatExamples, ...platformExamples];
}
