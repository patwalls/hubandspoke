import type { Task } from "graphile-worker";
import { refreshItemMetrics } from "@/lib/services/performance-decay";

export interface RefreshItemMetricsPayload {
  productionItemId: string;
}

/**
 * On-demand per-item metrics refresh. Enqueued from the web dyno whenever
 * a post is created or flipped to Published with a `publishedLink` — so
 * views/likes/comments land right away instead of waiting for the hourly
 * `performance-decay` sweep.
 *
 * Idempotent: the underlying `refreshItemMetrics` stamps
 * `lastPerformanceSyncAt` on both success and failure, and enqueue sites
 * use `jobKey: refresh-item-metrics-<id>` to dedupe rapid re-saves.
 */
export const refreshItemMetricsTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } = rawPayload as RefreshItemMetricsPayload;
  const start = Date.now();
  helpers.logger.info(`refresh-item-metrics start item=${productionItemId}`);
  const result = await refreshItemMetrics(productionItemId);
  helpers.logger.info(
    `refresh-item-metrics ok item=${productionItemId} platform=${result.platform} updated=${result.updated} credits=${result.creditsUsed} (${Date.now() - start}ms)`
  );
};
