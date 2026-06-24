// Thin wrappers around the existing service functions, turned into
// graphile-worker tasks so they can be driven by the crontab in
// `src/jobs/crontab.ts`. Zero logic change — the point of Phase 2 is to move
// scheduling off Heroku Scheduler and onto the worker dyno we already run.

import type { Task } from "graphile-worker";
import { syncFromNotion } from "@/lib/services/notion-sync";
import { syncPerformanceData } from "@/lib/services/performance-decay";
import { syncLinkMetrics } from "@/lib/services/link-metrics-sync";
import { runEvergreenScan } from "@/lib/services/evergreen-scan";
import { selectEnrichmentCandidates } from "@/lib/services/enrichment/orchestrator";
import { selectHookCandidates } from "@/lib/services/hook-extract/orchestrator";
import { selectHookFallbackCandidates } from "@/lib/services/hook-extract/fallback";
import { selectVisionCandidates } from "@/lib/services/hook-extract/vision";
import { selectDispatcherCandidates } from "@/lib/services/hook-extract/dispatcher";
import { selectExtractPosterCandidates } from "./extract-poster";
import type { ExtractPosterPayload } from "./extract-poster";
import { maybeAlertScCreditsExhausted } from "@/lib/services/sc-credits-watch";
import { maybeAlertDescriptCreditsExhausted } from "@/lib/services/descript-credits-watch";
import { maybeAlertYtArchiveBehind } from "@/lib/services/yt-archive-watch";
import { platformSupportsLatest } from "@/lib/services/account-content-sync";
import { getScorecardData } from "@/lib/services/scorecard";
import { sendDailyScorecardEmail } from "@/lib/email";
import { db } from "@/lib/db";
import { accounts, productionItems, users } from "@/lib/db/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { runScheduleReconcile } from "@/lib/services/schedule-reconcile/reconcile";
import type { EnrichItemPayload } from "./enrich-item";
import type { ExtractHookPayload } from "./extract-hook";
import type { HookFallbackPayload } from "./hook-fallback";
import type { VisionExtractPayload } from "./vision-extract";
import type { HookDispatchPayload } from "./hook-dispatch";
import type { AccountRefreshPayload } from "./account-refresh";
import type { AccountContentSyncPayload } from "./account-content-sync";

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
export const syncLinkMetricsTask: Task = timed("sync-link-metrics", () =>
  syncLinkMetrics()
);
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
/**
 * Cron parent task: fill `hook` on published items the LLM sweep doesn't
 * cover — long-form YouTube, tweets, LinkedIn, IG posts, newsletters, etc.
 * Also rescues short-form rows with no transcript. Pure DB work (no LLM),
 * so the per-sweep batch is large and cheap. Gated on hookExtractedAt IS
 * NULL so it never overrides an LLM/manual/clip-idea hook.
 */
export const hookFallbackSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("hook-fallback-sweep start");
  const candidates = await selectHookFallbackCandidates();
  for (const productionItemId of candidates) {
    const payload: HookFallbackPayload = { productionItemId };
    await helpers.addJob("hook-fallback", payload as never, {
      jobKey: `hook-fallback-${productionItemId}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `hook-fallback-sweep fanned out ${candidates.length} items (${Date.now() - start}ms)`
  );
};
/**
 * Cron parent task: run Haiku 4.5 vision on the poster image of every
 * short-form / video post to read the on-screen hook and build a one-line
 * cover description. Gated on vision_extracted_at IS NULL so it runs once
 * per item. Cost ~$0.001/item — small batch per sweep.
 */
export const visionExtractSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("vision-extract-sweep start");
  const candidates = await selectVisionCandidates();
  for (const productionItemId of candidates) {
    const payload: VisionExtractPayload = { productionItemId };
    await helpers.addJob("vision-extract", payload as never, {
      jobKey: `vision-extract-${productionItemId}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `vision-extract-sweep fanned out ${candidates.length} items (${Date.now() - start}ms)`
  );
};

/**
 * Cron parent task: ffmpeg poster fallback. For published short-form items
 * where enrichment archived the .mp4 but didn't get a `display_url`-derived
 * cover, this fans out per-item `extract-poster` jobs that grab frame 0 of
 * the video and upload it as a poster. Idempotent on `posterS3Key`.
 *
 * Sequenced after `enrichment-sweep` (`:20`) and before `vision-extract-sweep`
 * (`:55`) so vision finds a poster on the same hour the .mp4 lands.
 */
export const extractPosterSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("extract-poster-sweep start");
  const candidates = await selectExtractPosterCandidates();
  for (const productionItemId of candidates) {
    const payload: ExtractPosterPayload = { productionItemId };
    await helpers.addJob("extract-poster", payload as never, {
      jobKey: `extract-poster-${productionItemId}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `extract-poster-sweep fanned out ${candidates.length} items (${Date.now() - start}ms)`
  );
};
/**
 * Cron parent task: unified hook dispatcher. One Haiku call per item sees
 * every signal (title, caption, transcript opener, poster image) and picks
 * the best hook with source reasoning. Replaces the old three-sweep setup
 * (`hook-extract-sweep`, `hook-fallback-sweep`, `vision-extract-sweep`).
 * Gated on `hook_extracted_at IS NULL` and never overwrites clip_idea /
 * manual sources. Cost ~$0.001/item.
 */
export const hookDispatchSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("hook-dispatch-sweep start");
  const candidates = await selectDispatcherCandidates();
  for (const productionItemId of candidates) {
    const payload: HookDispatchPayload = { productionItemId };
    await helpers.addJob("hook-dispatch", payload as never, {
      jobKey: `hook-dispatch-${productionItemId}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `hook-dispatch-sweep fanned out ${candidates.length} items (${Date.now() - start}ms)`
  );
};
export const evergreenScanTask: Task = timed("evergreen-scan", () =>
  runEvergreenScan()
);

/**
 * Daily fan-out: enqueue one `account-content-sync` per active account on a
 * platform that SC supports. Always runs in `latest` mode (1 page). Historical
 * backfill is only triggered on account create or via the manual button.
 * Replaces the old MATG-only sync — MATG handles are just regular accounts
 * now.
 */
export const accountContentSyncSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("account-content-sync-sweep start");
  const rows = await db
    .select({
      id: accounts.id,
      platform: accounts.platform,
      handle: accounts.handle,
    })
    .from(accounts)
    .where(eq(accounts.isActive, true));
  let enqueued = 0;
  for (const row of rows) {
    if (!platformSupportsLatest(row.platform)) continue;
    const payload: AccountContentSyncPayload = {
      accountId: row.id,
      mode: "latest",
    };
    await helpers.addJob("account-content-sync", payload as never, {
      jobKey: `account-content-sync-${row.id}-latest`,
      jobKeyMode: "unsafe_dedupe",
    });
    enqueued++;
  }
  helpers.logger.info(
    `account-content-sync-sweep fanned out ${enqueued}/${rows.length} accounts (${Date.now() - start}ms)`
  );
};

/**
 * Schedule-reconcile sweep (every 10 min). Two jobs in one tick:
 *   1. Targeted freshness: enqueue `account-content-sync` (latest) for only
 *      the accounts that currently own a pending Scheduled item, so a post
 *      that just went live is discovered within ~10 min. Near-zero SC spend
 *      when nothing is scheduled.
 *   2. Match pass: run the reconciler over current data — it ties newly-
 *      synced Published posts back to their waiting Scheduled item
 *      (auto-merge ≥85, suggestion 55–84), and flags items aged past their
 *      per-post-type window as needs-attention.
 *
 * The matcher runs against whatever Published rows exist now, so a post
 * synced this tick is matched on the next tick — acceptable 10-min latency.
 */
export const scheduleReconcileSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("schedule-reconcile-sweep start");

  // Distinct accounts with a pending Scheduled item that hasn't been given
  // up on yet — only those need fresh platform data.
  const accountRows = await db
    .selectDistinct({ accountId: productionItems.accountId })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Scheduled"),
        isNotNull(productionItems.accountId),
        isNull(productionItems.scheduleNeedsAttentionAt),
        isNull(productionItems.deletedAt),
      ),
    );

  let enqueued = 0;
  for (const row of accountRows) {
    if (!row.accountId) continue;
    const payload: AccountContentSyncPayload = {
      accountId: row.accountId,
      mode: "latest",
    };
    await helpers.addJob("account-content-sync", payload as never, {
      jobKey: `account-content-sync-${row.accountId}-latest`,
      jobKeyMode: "unsafe_dedupe",
    });
    enqueued++;
  }

  const summary = await runScheduleReconcile();
  helpers.logger.info(
    `schedule-reconcile-sweep synced=${enqueued} considered=${summary.considered} ` +
      `merged=${summary.autoMerged} suggested=${summary.suggested} ` +
      `gaveUp=${summary.gaveUp} llmErrors=${summary.llmErrors} ` +
      `skipped=${summary.skipped} (${Date.now() - start}ms)`,
  );
};

/**
 * Daily scorecard email. Computes the rolling-7-day publish counts once,
 * then sends one email per opted-in user. Recipients are gated on
 * `users.daily_scorecard_email_enabled = true` — a column flipped via the
 * settings UI. Sends inline (no fan-out) since the recipient list is tiny;
 * each send is wrapped so a single Postmark failure doesn't starve the rest.
 */
export const dailyScorecardEmailTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("daily-scorecard-email start");
  const recipients = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.dailyScorecardEmailEnabled, true));
  if (recipients.length === 0) {
    helpers.logger.info(
      `daily-scorecard-email no recipients (${Date.now() - start}ms)`
    );
    return;
  }
  const data = await getScorecardData();
  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    try {
      await sendDailyScorecardEmail({ to: r.email, data });
      sent++;
    } catch (err) {
      failed++;
      helpers.logger.error(
        `daily-scorecard-email send failed for ${r.email}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  helpers.logger.info(
    `daily-scorecard-email sent=${sent} failed=${failed} of ${recipients.length} (${Date.now() - start}ms)`
  );
};

/**
 * Watchdog for Scrape Creators credit exhaustion. Looks at the last hour
 * of `sc_call_log` rows; if any returned a 402 / "out of credits" error,
 * sends an alert email to opted-in users and writes a `sync_logs` row
 * for dedupe so the next 4h of ticks stay quiet. Cheap query (single
 * COUNT + 1 SELECT). Drives the dashboard banner indirectly via the
 * shared detection helper.
 */
export const scCreditsWatchTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("sc-credits-watch start");
  try {
    const result = await maybeAlertScCreditsExhausted();
    helpers.logger.info(
      `sc-credits-watch ${result.reason} sent=${result.sent} failedCount=${result.state.failedCount} (${Date.now() - start}ms)`,
    );
  } catch (err) {
    helpers.logger.error(
      `sc-credits-watch failed (${Date.now() - start}ms): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
};

/**
 * Watchdog for Descript AI-credit exhaustion. Mirrors the SC watcher
 * but scans `graphile_worker.jobs.last_error` for "Insufficient AI
 * credits" on the descript-* task family. Same 4h email dedupe via
 * `sync_logs.sync_type='descript-credits-alert'`. Drives the dashboard
 * banner indirectly via the shared detection helper.
 */
export const descriptCreditsWatchTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("descript-credits-watch start");
  try {
    const result = await maybeAlertDescriptCreditsExhausted();
    helpers.logger.info(
      `descript-credits-watch ${result.reason} sent=${result.sent} failedCount=${result.state.failedCount} (${Date.now() - start}ms)`,
    );
  } catch (err) {
    helpers.logger.error(
      `descript-credits-watch failed (${Date.now() - start}ms): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
};

/**
 * Watchdog for the home-machine YouTube archiver (home-machine/yt-archive/).
 * The in-dyno youtube-download-sweep is a deliberate production noop
 * (YouTube bot-blocks datacenter IPs), so if the home cron stops — machine
 * off, wrapper broken, repo checkout wedged — archives silently stop landing.
 * Detects Published YouTube items stuck at zero download attempts past the
 * grace window, captures a grouped Sentry issue every tick while broken, and
 * emails ALERT_RECIPIENTS (6h dedupe via `sync_logs.sync_type=
 * 'yt-archive-alert'`). Cheap query (one indexed SELECT, limit 50).
 */
export const ytArchiveWatchTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("yt-archive-watch start");
  try {
    const result = await maybeAlertYtArchiveBehind();
    helpers.logger.info(
      `yt-archive-watch ${result.reason} sent=${result.sent} staleCount=${result.state.staleCount} (${Date.now() - start}ms)`,
    );
  } catch (err) {
    helpers.logger.error(
      `yt-archive-watch failed (${Date.now() - start}ms): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
};

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
