// Worker dyno entrypoint. Ran by `npm run worker` (declared in Procfile).
//
// Connects to Postgres, runs the task list, and handles SIGTERM gracefully so
// in-flight jobs finish before Heroku SIGKILLs us at the 30s mark.

import "./instrument"; // initializes Sentry — must come first
import { EventEmitter } from "events";
import * as Sentry from "@sentry/node";
import { run, type WorkerEvents } from "graphile-worker";
import { taskList } from "./tasks";
import { CRONTAB } from "./crontab";
import { buildPgPool } from "./pg-pool";
import {
  getBootAt,
  getInFlightJobs,
  getPoolId,
  markJobFinished,
  markJobStarted,
  setPoolId,
} from "./worker-identity";
import { RECONCILE_INTERVAL_MS, reconcileLocks } from "./lock-reconcile";
import { workerLogger } from "./worker-logger";
import { isBlockedError } from "./blocked";

async function main() {
  // Own pool with explicit SSL — Heroku Postgres requires it, and
  // graphile-worker's `connectionString` shortcut doesn't negotiate it.
  const pgPool = buildPgPool({ max: 6 });

  // Hand graphile an emitter we own so listeners are attached BEFORE the
  // pool boots — `pool:create` fires inside run(), too early to subscribe
  // on the returned runner.
  const events: WorkerEvents = new EventEmitter();
  events.on("pool:create", ({ workerPool }) => {
    setPoolId(workerPool.id);
    console.log(`[worker] pool=${workerPool.id}`);
  });
  events.on("job:start", ({ job }) => {
    markJobStarted({
      id: String(job.id),
      taskIdentifier: job.task_identifier,
      queueId: job.job_queue_id == null ? null : String(job.job_queue_id),
      startedAt: new Date(),
    });
  });
  events.on("job:complete", ({ job }) => {
    markJobFinished(String(job.id));
  });

  const runner = await run({
    pgPool,
    events,
    // Drops routine success/start lines — docs/automation.md → Log volume.
    logger: workerLogger,
    // Dropped from 4 → 2 (2026-05-06) when the worker was a 512 MB Basic
    // dyno and two parallel ffmpeg re-encodes hit R14. The dyno is a
    // Standard-2X (1 GB) now, but every ffmpeg job is serialized on the
    // `media-heavy` queue anyway, so 2 still fits: one media slot plus one
    // for everything else. Bump deliberately, with memory numbers.
    concurrency: 2,
    pollInterval: 2000,
    // Heroku sends SIGKILL 30s after SIGTERM; 20s of grace lets jobs finish
    // while leaving 10s of headroom for cleanup.
    gracefulShutdownAbortTimeout: 20_000,
    taskList,
    crontab: CRONTAB,
  });

  // Permanent task failures (max attempts exhausted) → Sentry. Transient
  // errors that succeed on retry are intentionally not captured to keep
  // signal high. A `blocked:` error is a state the UI already shows the
  // editor (needs media / transcript), not an incident — log it, don't page.
  runner.events.on("job:failed", ({ job, error }) => {
    if (isBlockedError(error)) {
      console.warn(`[worker] ${job.task_identifier} job=${job.id} ${String(error).slice(0, 300)}`);
      return;
    }
    Sentry.captureException(error, {
      tags: { task: job.task_identifier, source: "graphile-worker" },
      extra: {
        job_id: job.id,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
      },
    });
  });

  // ── Lock reconciliation (see lock-reconcile.ts) ─────────────────────────
  // At boot: release whatever the previous process left locked. Then every
  // minute: catch locks we hold on paper but aren't running. A clean pass
  // logs at boot and then every 15th pass (log drain cap), so "a clean line
  // in the last 15 min" is the proof the reconciler is alive.
  let cleanPasses = 0;
  const reconcile = async (reason: string) => {
    const poolId = getPoolId();
    if (!poolId) return;
    try {
      const r = await reconcileLocks({
        pool: pgPool,
        selfPoolId: poolId,
        bootAt: getBootAt(),
        inFlight: getInFlightJobs().map((j) => ({ id: j.id, queueId: j.queueId })),
      });
      if (r.acted || r.foreignLiveHolders.length > 0) {
        const summary =
          `orphans=${r.orphanHolders.join(",") || "-"} ` +
          `ghostJobs=${r.ghostJobIds.join(",") || "-"} ` +
          `ghostQueues=${r.ghostQueueIds.join(",") || "-"} ` +
          `foreignLive=${r.foreignLiveHolders.join(",") || "-"}`;
        console.warn(`[worker] lock-reconcile(${reason}) acted=${r.acted} ${summary}`);
        // Warning, not error: the worker healed itself. The point is a
        // visible trail of HOW OFTEN this happens, since each one is a
        // render that sat queued until this pass ran.
        Sentry.captureMessage(`graphile lock reconciled (${reason})`, {
          level: "warning",
          tags: { source: "graphile-worker", kind: "lock-reconcile" },
          fingerprint: ["graphile-lock-reconcile"],
          extra: { ...r, reason, poolId },
        });
      } else if (reason === "boot" || ++cleanPasses % 15 === 0) {
        console.log(`[worker] lock-reconcile(${reason}) clean`);
      }
    } catch (err) {
      console.error(`[worker] lock-reconcile(${reason}) failed:`, err);
      Sentry.captureException(err, { tags: { source: "graphile-worker", kind: "lock-reconcile" } });
    }
  };
  await reconcile("boot");
  const reconcileTimer = setInterval(() => void reconcile("interval"), RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconcileTimer);
    const inFlight = getInFlightJobs();
    console.log(
      `[worker] ${signal} received — shutting down gracefully (in-flight=${inFlight.length}${
        inFlight.length ? ": " + inFlight.map((j) => `${j.taskIdentifier}#${j.id}`).join(", ") : ""
      })`,
    );
    try {
      await runner.stop();
    } catch (err) {
      // runner.stop() throws if the runner already stopped itself (e.g. when
      // graphile-worker intercepted SIGTERM first). Safe to ignore.
      console.log(
        `[worker] runner.stop() noop: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await pgPool.end().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(
    `[worker] started concurrency=2 tasks=${Object.keys(taskList).join(",")}`
  );

  await runner.promise;
}

main().catch(async (err) => {
  console.error("[worker] fatal:", err);
  Sentry.captureException(err, { tags: { source: "graphile-worker", fatal: "true" } });
  await Sentry.flush(2000).catch(() => {});
  process.exit(1);
});
