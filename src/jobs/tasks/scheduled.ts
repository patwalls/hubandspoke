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
import { selectEnrichmentCandidates } from "@/lib/services/enrichment/orchestrator";
import { selectHookCandidates } from "@/lib/services/hook-extract/orchestrator";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { EnrichItemPayload } from "./enrich-item";
import type { ExtractHookPayload } from "./extract-hook";
import type { AccountRefreshPayload } from "./account-refresh";

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
/**
 * Cron parent task: select pending items and enqueue one `enrich-item` child
 * per item. Returns immediately; children run in parallel up to the worker's
 * concurrency. Replaces the old in-series `runEnrichmentSweep()` loop —
 * per-item failures no longer starve the rest of the batch.
 */
export const enrichmentSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("enrichment-sweep start");
  const candidates = await selectEnrichmentCandidates();
  for (const productionItemId of candidates) {
    const payload: EnrichItemPayload = { productionItemId };
    await helpers.addJob("enrich-item", payload as never, {
      // Coalesce duplicate enqueues across overlapping sweeps: if item A is
      // still pending from last tick, don't double-queue.
      jobKey: `enrich-${productionItemId}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `enrichment-sweep fanned out ${candidates.length} items (${Date.now() - start}ms)`
  );
};
/**
 * Cron parent task: select published short-form items missing a hook and
 * enqueue one `extract-hook` child per item. Separate from `enrichment-sweep`
 * because hook extraction is LLM-gated (Haiku), not SC-gated — mixing the
 * two would confuse retry semantics and error columns.
 */
export const hookExtractSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("hook-extract-sweep start");
  const candidates = await selectHookCandidates();
  for (const productionItemId of candidates) {
    const payload: ExtractHookPayload = { productionItemId };
    await helpers.addJob("extract-hook", payload as never, {
      jobKey: `extract-hook-${productionItemId}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `hook-extract-sweep fanned out ${candidates.length} items (${Date.now() - start}ms)`
  );
};
export const matgSyncTask: Task = timed("matg-sync", () => syncAllMATG());
export const evergreenScanTask: Task = timed("evergreen-scan", () =>
  runEvergreenScan()
);
export const crossPostScanTask: Task = timed("cross-post-scan", () =>
  runCrossPostScan()
);

/**
 * Weekly fan-out: enqueue one `account-refresh` per active account with an
 * SC-supported platform. Skipped platforms (newsletter, "other") don't get
 * refreshed — the service stamps them as "no coverage" on a manual refresh
 * but we don't waste cron ticks on them.
 */
export const accountRefreshSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("account-refresh-sweep start");
  const rows = await db
    .select({ id: accounts.id, platform: accounts.platform, handle: accounts.handle })
    .from(accounts)
    .where(
      and(
        eq(accounts.isActive, true),
        inArray(accounts.platform, ["youtube", "instagram", "x", "tiktok", "linkedin", "threads"])
      )
    );
  for (const row of rows) {
    const payload: AccountRefreshPayload = { accountId: row.id };
    await helpers.addJob("account-refresh", payload as never, {
      jobKey: `account-refresh-${row.id}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `account-refresh-sweep fanned out ${rows.length} accounts (${Date.now() - start}ms)`
  );
};
