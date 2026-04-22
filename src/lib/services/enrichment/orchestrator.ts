import { and, asc, eq, isNull, or, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { platformKindsFor, type PlatformKind } from "@/lib/services/performance-decay";
import { enrichInstagramItem } from "./instagram";
import { enrichYouTubeItem } from "./youtube";
import { enrichYouTubeCommunityItem } from "./youtube-community";
import { enrichTwitterItem } from "./twitter";
import { enrichThreadsItem } from "./threads";
import { enrichLinkedInItem } from "./linkedin";
import { enrichTikTokItem } from "./tiktok";
import type { EnrichmentResult } from "./types";

/** Items per sweep tick. Conservative — first sweep after deploy will be the
 *  largest because nothing is enriched yet; tune up once steady state hits. */
const SWEEP_BATCH_LIMIT = 50;

/** Max attempts before we stop retrying a broken item (until 24h cooldown). */
const MAX_ATTEMPTS = 5;

/**
 * Enrich a single item by ID — the entry point for the on-demand API route
 * and the backfill script. Mirrors the per-item path inside the sweep loop:
 * dispatches to the right enricher, persists the result, stamps either
 * `enrichment_completed_at` (success) or `enrichment_error` (failure).
 *
 * Returns the EnrichmentResult on success or null when no enricher matches
 * the item's platform. Throws on enricher failure — callers handle.
 */
export async function enrichSingleItem(
  itemId: string,
  options: { force?: boolean; withMedia?: boolean } = {}
): Promise<EnrichmentResult | null> {
  const [item] = await db
    .select({
      id: productionItems.id,
      platform: productionItems.platform,
      enrichmentCompletedAt: productionItems.enrichmentCompletedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);
  if (item.enrichmentCompletedAt && !options.force) {
    return null;
  }

  const kinds = platformKindsFor(
    (item.platform as string[] | null) ?? null
  );

  let result: EnrichmentResult | null;
  try {
    result = await dispatchEnrichment(itemId, kinds, {
      withMedia: options.withMedia,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(productionItems)
      .set({
        enrichmentAttempts: sql`${productionItems.enrichmentAttempts} + 1`,
        enrichmentError: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    throw err;
  }

  if (!result) return null;

  await db
    .update(productionItems)
    .set({
      ...result.updates,
      enrichmentCompletedAt: new Date(),
      enrichmentError: null,
      enrichmentAttempts: sql`${productionItems.enrichmentAttempts} + 1`,
    })
    .where(eq(productionItems.id, itemId));

  return result;
}

interface SweepSummary {
  scanned: number;
  enriched: number;
  failed: number;
  skipped: number;
  creditsSpent: number;
  errors: Array<{ itemId: string; message: string }>;
}

export interface SweepOptions {
  /** Override the default 50-item batch. Useful for backfill catch-up. */
  limit?: number;
  /** Restrict to a single PlatformKind. Default: all. */
  platform?: PlatformKind;
  /** Re-enrich items even if `enrichment_completed_at` is set. Use sparingly
   *  — burns SC credits on rows we already have. */
  force?: boolean;
  /** For Instagram only: also archive the raw video file to S3 (10 SC credits
   *  per item, vs ~2 without). Off by default — auto sweep gets the cheap
   *  signals (caption + poster + transcript + author) and skips the video.
   *  Backfills can opt in for the full archive. */
  withMedia?: boolean;
}

/**
 * Pick the right per-platform enricher for an item. Returns null if no
 * platform on the item has an enricher implemented yet — those items are
 * skipped (but not marked complete) so they get picked up when the platform
 * lands. First-match wins: order favors signal-richest platforms (IG/TikTok
 * have media + transcript; LinkedIn has body only) so cross-posted items get
 * the most data.
 */
export async function dispatchEnrichment(
  itemId: string,
  kinds: Set<PlatformKind>,
  options: { withMedia?: boolean } = {}
): Promise<EnrichmentResult | null> {
  if (kinds.has("instagram")) {
    return enrichInstagramItem(itemId, { withMedia: options.withMedia });
  }
  if (kinds.has("tiktok")) return enrichTikTokItem(itemId);
  if (kinds.has("youtube")) return enrichYouTubeItem(itemId);
  if (kinds.has("youtube_community")) return enrichYouTubeCommunityItem(itemId);
  if (kinds.has("twitter")) return enrichTwitterItem(itemId);
  if (kinds.has("threads")) return enrichThreadsItem(itemId);
  if (kinds.has("linkedin")) return enrichLinkedInItem(itemId);
  return null;
}

/**
 * One sweep tick: pick up to N published items missing enrichment, run their
 * platform's enricher, persist results. Per-item failures are isolated so a
 * single bad URL doesn't tank the whole batch.
 *
 * Backfill callers can pass `options` to override the batch size, restrict
 * to a single platform, or force re-enrichment of already-enriched items.
 */
export async function runEnrichmentSweep(
  options: SweepOptions = {}
): Promise<SweepSummary> {
  const startedAt = new Date();
  const summary: SweepSummary = {
    scanned: 0,
    enriched: 0,
    failed: 0,
    skipped: 0,
    creditsSpent: 0,
    errors: [],
  };

  const limit = options.limit ?? SWEEP_BATCH_LIMIT;
  const cooldownCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Eligible: published items without a successful enrichment, retried fewer
  // than MAX_ATTEMPTS times OR last attempted >24h ago. Newest-first so the
  // freshest content gets archived before its CDN URLs expire. Force mode
  // skips the enrichment-gate clause so already-enriched rows re-enter.
  const baseConditions = options.force
    ? [eq(productionItems.status, "Published")]
    : [
        eq(productionItems.status, "Published"),
        isNull(productionItems.enrichmentCompletedAt),
        or(
          lt(productionItems.enrichmentAttempts, MAX_ATTEMPTS),
          lt(productionItems.updatedAt, cooldownCutoff)
        )!,
      ];

  const candidates = await db
    .select({
      id: productionItems.id,
      platform: productionItems.platform,
      publishedLink: productionItems.publishedLink,
      enrichmentAttempts: productionItems.enrichmentAttempts,
      updatedAt: productionItems.updatedAt,
    })
    .from(productionItems)
    .where(and(...baseConditions))
    .orderBy(asc(productionItems.enrichmentAttempts), asc(productionItems.updatedAt))
    .limit(limit);

  summary.scanned = candidates.length;

  for (const item of candidates) {
    const kinds = platformKindsFor(
      (item.platform as string[] | null) ?? null
    );

    // Platform filter — applied here (after the SQL select) rather than in
    // SQL because `platform` is a jsonb array and JSON-path predicates are
    // ugly. Cheap to filter in JS — `limit` already caps the candidate set.
    if (options.platform && !kinds.has(options.platform)) {
      summary.skipped++;
      continue;
    }

    let result: EnrichmentResult | null = null;
    try {
      result = await dispatchEnrichment(item.id, kinds, {
        withMedia: options.withMedia,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed++;
      summary.errors.push({ itemId: item.id, message });
      await db
        .update(productionItems)
        .set({
          enrichmentAttempts: sql`${productionItems.enrichmentAttempts} + 1`,
          enrichmentError: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, item.id));
      continue;
    }

    if (!result) {
      // No enricher implemented yet for this platform — leave it pending so
      // a future deploy can pick it up. Don't increment attempts.
      summary.skipped++;
      continue;
    }

    summary.creditsSpent += result.creditsSpent;
    summary.enriched++;

    await db
      .update(productionItems)
      .set({
        ...result.updates,
        enrichmentCompletedAt: new Date(),
        enrichmentError: null,
        enrichmentAttempts: sql`${productionItems.enrichmentAttempts} + 1`,
      })
      .where(eq(productionItems.id, item.id));
  }

  await db.insert(syncLogs).values({
    syncType: "enrichment-sweep",
    status: summary.failed > 0 ? "partial" : "success",
    itemsUpdated: summary.enriched,
    errorMessage:
      summary.errors.length > 0
        ? JSON.stringify(summary.errors).slice(0, 2000)
        : null,
    startedAt,
    completedAt: new Date(),
  });

  return summary;
}
