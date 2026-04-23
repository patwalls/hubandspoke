import type { Task } from "graphile-worker";
import { applyFallbackHookForItem } from "@/lib/services/hook-extract/fallback";

export interface HookFallbackPayload {
  productionItemId: string;
}

/**
 * One production-item's fallback hook fill. Child of the scheduled
 * `hook-fallback-sweep` parent task. Idempotent on `hook_extracted_at`.
 * Cheap (pure DB work, no LLM call), but runs as a per-item task so a bad
 * row doesn't starve the batch.
 */
export const hookFallbackTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } = rawPayload as HookFallbackPayload;
  const start = Date.now();
  helpers.logger.info(`hook-fallback start item=${productionItemId}`);
  const result = await applyFallbackHookForItem(productionItemId);
  helpers.logger.info(
    `hook-fallback ${result.status} item=${productionItemId}${
      result.source ? ` source=${result.source}` : ""
    }${result.note ? ` note=${result.note}` : ""} (${Date.now() - start}ms)`
  );
};
