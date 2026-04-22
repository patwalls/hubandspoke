// Thin wrappers around the existing service functions, turned into
// graphile-worker tasks so they can be driven by the crontab in
// `src/jobs/crontab.ts`. Zero logic change — the point of Phase 2 is to move
// scheduling off Heroku Scheduler and onto the worker dyno we already run.

import type { Task } from "graphile-worker";
import { syncFromNotion } from "@/lib/services/notion-sync";
import { syncPerformanceData } from "@/lib/services/performance-decay";
import { runEvergreenScan } from "@/lib/services/evergreen-scan";
import { runCrossPostScan } from "@/lib/services/cross-post-scan";
import { syncAllMATG } from "@/lib/services/matg-sync";
import { runEnrichmentSweep } from "@/lib/services/enrichment/orchestrator";

function timed(name: string, fn: () => Promise<unknown>): Task {
  return async (_payload, helpers) => {
    const start = Date.now();
    helpers.logger.info(`${name} start`);
    try {
      await fn();
      helpers.logger.info(`${name} ok (${Date.now() - start}ms)`);
    } catch (err) {
      helpers.logger.error(
        `${name} failed (${Date.now() - start}ms): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      throw err;
    }
  };
}

export const performanceDecayTask: Task = timed("performance-decay", () =>
  syncPerformanceData()
);
export const notionSyncTask: Task = timed("notion-sync", () => syncFromNotion());
export const enrichmentSweepTask: Task = timed("enrichment-sweep", () =>
  runEnrichmentSweep()
);
export const matgSyncTask: Task = timed("matg-sync", () => syncAllMATG());
export const evergreenScanTask: Task = timed("evergreen-scan", () =>
  runEvergreenScan()
);
export const crossPostScanTask: Task = timed("cross-post-scan", () =>
  runCrossPostScan()
);
