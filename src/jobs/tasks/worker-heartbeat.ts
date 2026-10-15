import type { Task } from "graphile-worker";
import { db } from "@/lib/db";
import { workerHeartbeat } from "@/lib/db/schema";
import { getPoolId } from "../worker-identity";

/**
 * Per-minute liveness ping. Upserts the singleton `worker_heartbeat` row
 * with `last_seen_at = NOW()`. Read by `GET /api/health/worker`, which an
 * external uptime monitor polls — when `last_seen_at` falls behind the
 * 3-minute threshold, the endpoint returns 503 and the monitor pages us.
 *
 * Catches the silent-wedge failure mode we hit 2026-05-15: the worker
 * process stayed alive (Heroku healthcheck happy) but stopped polling
 * the jobs table for ~10h, so backed-up `performance-decay` jobs (and
 * one user's `refresh-item-metrics`) never ran. A wedged worker can't
 * fire this task either, which is precisely why a stale row is the
 * signal.
 *
 * Also publishes this process's graphile pool id so the web dyno's
 * `/api/health/queue` can judge whether a held lock belongs to a live
 * worker (src/jobs/lock-reconcile.ts explains the pool-id semantics).
 */
export const workerHeartbeatTask: Task = async () => {
  await db
    .insert(workerHeartbeat)
    .values({
      id: "singleton",
      lastSeenAt: new Date(),
      workerDyno: process.env.DYNO ?? null,
      poolId: getPoolId(),
    })
    .onConflictDoUpdate({
      target: workerHeartbeat.id,
      set: {
        lastSeenAt: new Date(),
        workerDyno: process.env.DYNO ?? null,
        poolId: getPoolId(),
      },
    });
};
