import type { Task } from "graphile-worker";
import { extractHookForItem } from "@/lib/services/hook-extract/orchestrator";

export interface ExtractHookPayload {
  productionItemId: string;
}

/**
 * One production-item's hook extraction. Child of the scheduled
 * `hook-extract-sweep` parent task — many of these run in parallel up to the
 * worker's concurrency, mirroring the enrichment pattern.
 *
 * `extractHookForItem` is idempotent on `hook_extracted_at`, so a retry after
 * a partial failure (Haiku 5xx, DB blip) is safe.
 */
export const extractHookTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } = rawPayload as ExtractHookPayload;
  const start = Date.now();
  helpers.logger.info(`extract-hook start item=${productionItemId}`);
  const result = await extractHookForItem(productionItemId);
  helpers.logger.info(
    `extract-hook ${result.status} item=${productionItemId}${
      result.note ? ` note=${result.note}` : ""
    } (${Date.now() - start}ms)`
  );
};
