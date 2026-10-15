import type { Task } from "graphile-worker";
import { enrichSingleItem } from "@/lib/services/enrichment/orchestrator";
import { recordScUsage } from "@/lib/services/sc-usage-log";

export interface EnrichItemPayload {
  productionItemId: string;
  /** Re-enrich even if `enrichment_completed_at` is already set. */
  force?: boolean;
  /** Instagram-only: also archive the raw video to S3 (10 SC credits vs ~2). */
  withMedia?: boolean;
}

/**
 * One production-item's enrichment. Child of the scheduled
 * `enrichment-sweep` parent task — many of these run in parallel up to the
 * worker's `concurrency` (default 4), replacing the old serial 50-item loop
 * in `runEnrichmentSweep`.
 *
 * `enrichSingleItem` is idempotent on `enrichment_completed_at`, so a retry
 * after a partial failure is safe.
 */
export const enrichItemTask: Task = async (rawPayload, helpers) => {
  const { productionItemId, force, withMedia } =
    rawPayload as EnrichItemPayload;
  const start = Date.now();
  // Debug, not info: the hourly sweep enqueues hundreds of these and almost
  // all skip. At three info lines each they flushed Heroku's 1500-line log
  // buffer in ~7 minutes (2026-10-15), erasing the record of a worker
  // restart we needed. One line per job that actually did work.
  helpers.logger.debug(`enrich-item start item=${productionItemId}`);
  const result = await enrichSingleItem(productionItemId, { force, withMedia });
  if (!result) {
    helpers.logger.debug(
      `enrich-item skipped item=${productionItemId} reason=already-enriched-or-no-enricher`
    );
    return;
  }
  helpers.logger.info(
    `enrich-item ok item=${productionItemId} credits=${result.creditsSpent} (${Date.now() - start}ms)`
  );
  if (result.creditsSpent > 0) {
    const noteParts: string[] = [];
    if (force) noteParts.push("force=true");
    if (withMedia) noteParts.push("withMedia=true:10cr");
    void recordScUsage({
      caller: "enrich-item",
      productionItemId,
      credits: result.creditsSpent,
      ok: true,
      notes: noteParts.length ? noteParts.join(" ") : null,
      durationMs: Date.now() - start,
    });
  }
};
