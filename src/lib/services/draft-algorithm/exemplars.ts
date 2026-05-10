import { and, desc, eq, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
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

// v1.6: wall-time cap on on-demand exemplar enrichment. Enrichment runs in
// parallel for any top-N format-scoped item that's missing contentBody.
// 10s is generous: SC's tweet endpoint is usually <2s; we set the cap
// high so even a slow LinkedIn enrichment + image archive completes.
// Items that don't finish are dropped (logged) — never blocks the draft.
const ENRICHMENT_WALL_TIME_MS = 10_000;

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
 * v1.2: format-scoped first, top up with platform-scoped only when sparse.
 *
 * v1.6: the format-scoped query no longer pre-filters on `contentBody IS
 * NOT NULL` — it pulls the TOP N by views regardless of enrichment state,
 * then on-demand enriches any rows missing a body before composing the
 * exemplar pool. The previous behavior silently biased the pool to "top
 * performers that happen to be enriched"; the 373K-view tweet that was
 * never enriched got skipped entirely. Format-scoped exemplars carry the
 * structural template, so missing a top performer there meaningfully
 * hurts the algorithm. Platform-scoped top-up rows DO keep the
 * content_body filter — they're voice/tone reference, not structural, and
 * we don't want to fan out N more SC calls per draft.
 */
export async function getTopPerformingCaptions(
  args: GetTopPerformingCaptionsArgs,
): Promise<PastCaptionExample[]> {
  const { brand, postType, format, excludeId } = args;

  // Filters shared by both the format-scoped (no body filter) and the
  // platform-scoped top-up (which keeps the body filter for credit cost).
  const sharedFilters = [
    eq(productionItems.brand, brand),
    eq(productionItems.postType, postType),
    eq(productionItems.status, "Published"),
    ne(productionItems.id, excludeId),
    sql`${productionItems.publishedAt} > now() - (${FRESHNESS_DAYS} || ' days')::interval`,
  ];

  // Platform-scoped path: when there's no format on the item, behave like
  // v1.5 — top by views with the contentBody filter, no enrichment hop.
  if (!format) {
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
          ...sharedFilters,
          isNotNull(productionItems.contentBody),
          sql`length(trim(${productionItems.contentBody})) > 0`,
        ),
      )
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

  // Format-scoped path: top N by views regardless of body state. Case-
  // insensitive format match — same idiom used by the repurpose route.
  const formatRowsRaw = await db
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
        ...sharedFilters,
        sql`lower(${productionItems.format}) = lower(${format})`,
      ),
    )
    .orderBy(
      sql`${productionItems.views} desc nulls last`,
      desc(productionItems.publishedAt),
    )
    .limit(MAX_PAST_CAPTIONS);

  // On-demand enrich any top performers missing a body. ensureExemplarsEnriched
  // runs SC calls in parallel with a 10s total wall-time cap.
  await ensureExemplarsEnriched(formatRowsRaw);

  // Re-fetch contentBody (and recompute the rank order) for the same id
  // set after enrichment settled. Maintains the original view-rank.
  const ids = formatRowsRaw.map((r) => r.id);
  const refreshed =
    ids.length > 0
      ? await db
          .select({
            id: productionItems.id,
            caption: productionItems.contentBody,
            publishedAt: productionItems.publishedAt,
            publishedLink: productionItems.publishedLink,
            views: productionItems.views,
          })
          .from(productionItems)
          .where(inArray(productionItems.id, ids))
      : [];
  const refreshedById = new Map(refreshed.map((r) => [r.id, r]));

  const formatExamples: PastCaptionExample[] = [];
  const droppedIds: string[] = [];
  for (const raw of formatRowsRaw) {
    const row = refreshedById.get(raw.id) ?? raw;
    const body = row.caption?.trim();
    if (!body || body.length === 0) {
      droppedIds.push(raw.id);
      continue;
    }
    formatExamples.push({
      caption: body,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      publishedLink: row.publishedLink ?? null,
      views: row.views ?? null,
      source: "format",
    });
  }
  if (droppedIds.length > 0) {
    console.warn(
      `exemplars: dropped ${droppedIds.length} top format performers with no contentBody after enrichment: ${droppedIds.join(", ")}`,
    );
  }

  if (formatExamples.length >= MIN_FORMAT_EXAMPLES_BEFORE_TOPUP) {
    return formatExamples;
  }

  // Top-up with platform-scoped (keep contentBody filter — no enrichment).
  const remainingSlots = MAX_PAST_CAPTIONS - formatExamples.length;
  const excludedIds = formatRowsRaw.map((r) => r.id);
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
        ...sharedFilters,
        isNotNull(productionItems.contentBody),
        sql`length(trim(${productionItems.contentBody})) > 0`,
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

/**
 * Run `enrichSingleItem` on every row whose contentBody is empty. All
 * enrichments fire in parallel; the whole pass is bounded by
 * `ENRICHMENT_WALL_TIME_MS` so a slow SC endpoint never stalls drafting.
 * Per-row failures (network, 404, missing fields) are caught + logged;
 * the corresponding row stays empty and gets dropped by the caller.
 */
async function ensureExemplarsEnriched(
  rows: ReadonlyArray<{ id: string; caption: string | null }>,
): Promise<void> {
  const needs = rows.filter((r) => !r.caption || r.caption.trim().length === 0);
  if (needs.length === 0) return;

  const enrichPromises = needs.map((r) =>
    enrichSingleItem(r.id).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `exemplars: inline enrich failed for ${r.id}: ${message.slice(0, 200)}`,
      );
      return null;
    }),
  );

  console.info(
    `exemplars: inline enriching ${needs.length} top performer(s) missing contentBody: ${needs.map((r) => r.id).join(", ")}`,
  );

  await Promise.race([
    Promise.allSettled(enrichPromises),
    new Promise<void>((resolve) =>
      setTimeout(resolve, ENRICHMENT_WALL_TIME_MS),
    ),
  ]);
}
