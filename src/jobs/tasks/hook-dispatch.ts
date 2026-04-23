import type { Task } from "graphile-worker";
import { dispatchHookForItem } from "@/lib/services/hook-extract/dispatcher";

export interface HookDispatchPayload {
  productionItemId: string;
}

/**
 * One production-item's unified hook pick. Child of the scheduled
 * `hook-dispatch-sweep`. Idempotent on `hook_extracted_at`. Refuses to
 * overwrite `clip_idea` / `manual` sources.
 *
 * Replaces the old per-item tasks `extract-hook`, `hook-fallback`, and
 * `vision-extract` (which remain registered for back-compat with any queued
 * jobs but are no longer fanned out by cron).
 */
export const hookDispatchTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } = rawPayload as HookDispatchPayload;
  const start = Date.now();
  helpers.logger.info(`hook-dispatch start item=${productionItemId}`);
  const result = await dispatchHookForItem(productionItemId);
  helpers.logger.info(
    `hook-dispatch ${result.status} item=${productionItemId}${
      result.source ? ` source=${result.source}` : ""
    }${result.note ? ` note=${result.note}` : ""} (${Date.now() - start}ms)`
  );
};
