import { and, asc, eq, isNull, or, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { resolveItemPlatformKinds, type PlatformKind } from "@/lib/services/performance-decay";
import { enrichInstagramItem } from "./instagram";
import { enrichYouTubeItem } from "./youtube";
import { enrichYouTubeCommunityItem } from "./youtube-community";
import { enrichTwitterItem } from "./twitter";
import { enrichThreadsItem } from "./threads";
import { enrichLinkedInItem } from "./linkedin";
import { enrichTikTokItem } from "./tiktok";
import { enrichNewsletterItem } from "./newsletter";
import { maybeEnqueueWhisperTranscribe } from "@/lib/services/transcribe-after-upload";
import { isPermanentEnrichmentError } from "./errors";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";
import type { EnrichmentResult } from "./types";

/** Columns enrichment writes that we audit in the activity feed. Excludes
 *  pure system-state columns (enrichment_* counters, media_s3_* mirrors,
 *  thumbnail URL, performance metrics) — those change on every sweep and
 *  have no audit value. Title is excluded because Notion-authoritative
 *  items already capture title changes through `cron:notion-sync`. */
const AUDITED_ENRICHMENT_FIELDS = [
  "hook",
  "overlay",
  "description",
  "coverDescription",
  "contentBody",
  "authorHandle",
  "authorDisplayName",
] as const;

/**
 * Compare an enrichment-result `updates` payload against the item's
 * current row state and emit one `content_changed` event per audited
 * field that actually moved. Source is the `enrichment` algorithm —
 * activity feed renders these under the "Show system changes" filter.
 *
 * Best-effort: failure here logs and continues so we don't unwind an
 * otherwise-successful enrichment.
 */
async function auditEnrichmentDiff(
  itemId: string,
  updates: Partial<typeof productionItems.$inferInsert>,
  before: Record<string, unknown>,
): Promise<void> {
  const changes: ContentChange[] = [];
  for (const key of AUDITED_ENRICHMENT_FIELDS) {
    const incoming = updates[key];
    if (incoming === undefined) continue;
    const fromVal = before[key];
    if (fromVal === incoming) continue;
    changes.push({
      target: { kind: "production_item_field", field: key },
      from: (fromVal ?? null) as string | number | boolean | null,
      to: (incoming ?? null) as string | number | boolean | null,
    });
  }
  if (changes.length === 0) return;
  try {
    await recordContentChanges({
      tx: db,
      contentItemId: itemId,
      userId: null,
      source: { kind: "algorithm", name: "enrichment" },
      changes,
    });
  } catch (err) {
    console.error(
      `[enrichment] audit emit failed for item=${itemId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Apply an enrichment result's column updates and stamp the row complete.
 *
 * If writing `platform_content_id` collides with another row that already
 * claims the same global id (Postgres 23505 on
 * `uniq_production_items_platform_content_id_global` — two production_items
 * backed by the same underlying post, e.g. a newsletter campaign linked
 * twice), we drop that single column and persist the rest of the enrichment
 * rather than crash the task. The collision is a durable data condition, not a
 * transient fault, so it doesn't warrant a retry or a Sentry page.
 */
export async function persistEnrichmentUpdates(
  itemId: string,
  updates: Partial<typeof productionItems.$inferInsert>,
): Promise<void> {
  try {
    await db
      .update(productionItems)
      .set({
        ...updates,
        enrichmentCompletedAt: new Date(),
        enrichmentError: null,
        enrichmentAttempts: sql`${productionItems.enrichmentAttempts} + 1`,
      })
      .where(eq(productionItems.id, itemId));
  } catch (err) {
    // Drizzle wraps the driver error ("Failed query: update ...") and puts
    // the PostgresError on `cause` — code/constraint_name live THERE, not on
    // the wrapper. Reading the wrapper meant this handler never fired and
    // every collision retried to a 25/25 corpse (Sentry HUBANDSPOKE-1Y/-2M;
    // fixed 2026-08-13). Unwrap one level, fall back to the error itself.
    const pgErr =
      err instanceof Error && err.cause && typeof err.cause === "object"
        ? (err.cause as { code?: string; constraint_name?: string })
        : (err as { code?: string; constraint_name?: string });
    const code = pgErr?.code;
    const constraint = pgErr?.constraint_name ?? "";
    const isPlatformIdCollision =
      code === "23505" &&
      "platformContentId" in updates &&
      (constraint === "" || constraint.includes("platform_content_id"));
    if (!isPlatformIdCollision) throw err;

    console.warn(
      `[enrichment] platform_content_id collision for item=${itemId}; persisting without it`,
    );
    const rest = { ...updates };
    delete rest.platformContentId;
    await db
      .update(productionItems)
      .set({
        ...rest,
        enrichmentCompletedAt: new Date(),
        enrichmentError: "platform_content_id collision — kept existing id",
        enrichmentAttempts: sql`${productionItems.enrichmentAttempts} + 1`,
      })
      .where(eq(productionItems.id, itemId));
  }
}

/** Items per sweep tick. Conservative — first sweep after deploy will be the
 *  largest because nothing is enriched yet; tune up once steady state hits. */
export const SWEEP_BATCH_LIMIT = 50;

/** Max attempts before we stop retrying a broken item (until 24h cooldown). */
const MAX_ATTEMPTS = 5;

/**
 * Select production-item IDs due for enrichment. Shared by the in-process
 * {@link runEnrichmentSweep} loop and the Graphile Worker parent task that
 * fans work out to per-item child jobs.
 */
export async function selectEnrichmentCandidates(
  limit: number = SWEEP_BATCH_LIMIT
): Promise<string[]> {
  const cooldownCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        isNull(productionItems.enrichmentCompletedAt),
        or(
          lt(productionItems.enrichmentAttempts, MAX_ATTEMPTS),
          lt(productionItems.updatedAt, cooldownCutoff)
        )!
      )
    )
    .orderBy(
      asc(productionItems.enrichmentAttempts),
      asc(productionItems.updatedAt)
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

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
      postType: productionItems.postType,
      enrichmentCompletedAt: productionItems.enrichmentCompletedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Production item ${itemId} not found`);
  if (item.enrichmentCompletedAt && !options.force) {
    return null;
  }

  const kinds = resolveItemPlatformKinds({ postType: item.postType });

  let result: EnrichmentResult | null;
  try {
    result = await dispatchEnrichment(itemId, kinds, {
      withMedia: options.withMedia,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Permanent per-item failure (bad/missing URL, deleted source post): stamp
    // the row to MAX_ATTEMPTS so it drops out of the retry queue, then swallow
    // the error — no graphile-worker retry storm, no Sentry page. Left
    // un-completed so a corrected published_link self-heals via the 24h sweep.
    const permanent = isPermanentEnrichmentError(err);
    await db
      .update(productionItems)
      .set({
        enrichmentAttempts: permanent
          ? MAX_ATTEMPTS
          : sql`${productionItems.enrichmentAttempts} + 1`,
        enrichmentError: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    if (permanent) return null;
    throw err;
  }

  // No enricher matched this item's platform — null/unmapped post_type
  // (see dispatchEnrichment / platformKindFromPostType). Stamp the row so it
  // drops out of the (attempts ASC, updated_at ASC) selection instead of
  // staying pinned to the front of the queue and eating the whole sweep batch
  // every tick. Mirrors the performance-decay path's stampSyncResult() guard.
  // The 24h cooldown clause in selectEnrichmentCandidates still re-checks it
  // later, so if an enricher for its platform lands the item picks back up.
  if (!result) {
    await db
      .update(productionItems)
      .set({
        enrichmentAttempts: MAX_ATTEMPTS,
        enrichmentError: `no-enricher-for-post-type:${item.postType ?? "null"}`,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, itemId));
    return null;
  }

  // Snapshot audited fields before applying the update so we can diff
  // and emit `content_changed` events for any of them that moved.
  const [beforeRow] = await db
    .select({
      hook: productionItems.hook,
      overlay: productionItems.overlay,
      description: productionItems.description,
      coverDescription: productionItems.coverDescription,
      contentBody: productionItems.contentBody,
      authorHandle: productionItems.authorHandle,
      authorDisplayName: productionItems.authorDisplayName,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  await persistEnrichmentUpdates(itemId, result.updates);

  if (beforeRow) {
    await auditEnrichmentDiff(itemId, result.updates, beforeRow);
  }

  // If this enrichment just wrote a new mediaS3Key, kick off a Whisper
  // transcribe — every archived video/audio item should get a transcript
  // even when the platform's native transcript source (SC captions on
  // YouTube, SC transcript on IG reels <2 min) didn't produce one. Noop
  // when the item already has a transcript.
  if (result.updates.mediaS3Key) {
    await maybeEnqueueWhisperTranscribe(itemId);
  }

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
  if (kinds.has("klaviyo")) return enrichNewsletterItem(itemId);
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
      postType: productionItems.postType,
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
    const kinds = resolveItemPlatformKinds({ postType: item.postType });

    // Platform filter — applied here (after the SQL select) on `kinds`,
    // which is derived from `post_type`. Cheap to filter in JS — `limit`
    // already caps the candidate set.
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
      // Permanent failures max out attempts so they leave the queue; transient
      // ones just increment so the 24h cooldown retries them. Either way the
      // per-item failure is isolated — one bad URL doesn't tank the batch.
      const permanent = isPermanentEnrichmentError(err);
      await db
        .update(productionItems)
        .set({
          enrichmentAttempts: permanent
            ? MAX_ATTEMPTS
            : sql`${productionItems.enrichmentAttempts} + 1`,
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

    const [beforeRow] = await db
      .select({
        hook: productionItems.hook,
        overlay: productionItems.overlay,
        description: productionItems.description,
        coverDescription: productionItems.coverDescription,
        contentBody: productionItems.contentBody,
        authorHandle: productionItems.authorHandle,
        authorDisplayName: productionItems.authorDisplayName,
      })
      .from(productionItems)
      .where(eq(productionItems.id, item.id))
      .limit(1);

    await persistEnrichmentUpdates(item.id, result.updates);

    if (beforeRow) {
      await auditEnrichmentDiff(item.id, result.updates, beforeRow);
    }
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
