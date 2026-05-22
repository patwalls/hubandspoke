import type { Task } from "graphile-worker";
import { generateClipIdeasForItem } from "@/lib/services/clip-idea-generate";

export interface GenerateClipIdeasPayload {
  productionItemId: string;
  /** Required (since 2026-05-21 multi-format split). One worker job per
   *  (pillar, clippable-format). Manual-route fan-out enqueues N jobs
   *  per pillar — one per `is_clippable_format=true` row on the brand —
   *  so X Quotables and Repackage Section w/ Hook run independently. */
  targetFormatId: string;
  /** When true, regenerate even if a batch already exists for this
   *  (pillar, format) pair. Used by the manual Regenerate button. */
  force?: boolean;
  /** When true, skip the post_type gate. Set by the manual route — the
   *  operator already chose the pillar. */
  skipPostTypeGate?: boolean;
  /** v10 (2026-05-22): re-run section detection from scratch. Kills the
   *  existing live batch + cascade-deletes derived clip_ideas across
   *  every format, then re-detects. Implies `force`. */
  forceSections?: boolean;
}

/**
 * Background unit of work for clip-idea generation. Each enqueue produces
 * one batch of 10 ideas for a single (pillar, target format) pair. The
 * manual-route fan-out enqueues one of these per clippable format on the
 * brand; the backfill script also dispatches per-format jobs.
 *
 * Idempotent — the service short-circuits if any clip_ideas row already
 * exists for (pillar, target_format), so retries after a Sonnet timeout
 * / DB blip are safe (unless `force` is set).
 *
 * Cost: one Sonnet call per (pillar, format) pair (~$0.10). With two
 * clippable formats per brand, a fan-out costs ~$0.20 per pillar.
 */
export const generateClipIdeasTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as GenerateClipIdeasPayload;
  const start = Date.now();
  helpers.logger.info(
    `generate-clip-ideas start item=${payload.productionItemId} format=${payload.targetFormatId}`,
  );
  const outcome = await generateClipIdeasForItem(payload.productionItemId, {
    targetFormatId: payload.targetFormatId,
    force: payload.force,
    skipPostTypeGate: payload.skipPostTypeGate,
    forceSections: payload.forceSections,
  });
  if (outcome.status === "ok") {
    helpers.logger.info(
      `generate-clip-ideas ok item=${payload.productionItemId} format=${outcome.targetFormat} ideas=${outcome.ideasCreated} batch=${outcome.batchId} (${Date.now() - start}ms)`,
    );
  } else {
    helpers.logger.info(
      `generate-clip-ideas skip item=${payload.productionItemId} format=${payload.targetFormatId} reason=${outcome.reason} (${Date.now() - start}ms)`,
    );
  }
};
