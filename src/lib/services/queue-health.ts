/**
 * Read model behind `GET /api/health/queue` — "is the background queue
 * actually moving?" as opposed to `/api/health/worker`'s "is the worker
 * process alive?". 2026-10-15 showed the gap: the heartbeat was green all
 * day while the serial `media-heavy` queue sat wedged behind an orphaned
 * lock and clip renders queued for hours.
 *
 * `evaluateQueueHealth` is pure so the thresholds are unit-tested; the
 * route feeds it the rows. Thresholds are deliberately generous — this
 * pages a human, so every red must be worth a phone buzz.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { RENDER_QUEUE_STALL_MS, RENDER_STALL_MS } from "@/lib/services/clip-editor/render-status";

/** Oldest job that is due, unlocked and retryable but still sitting there.
 *  A job behind a serial queue the live worker is busy on is measured from
 *  when that queue took its current job, not from its own `run_at`: a
 *  backlog that drains one 5-minute diarize chunk at a time is moving, and
 *  2026-10-26 paged on exactly that (a 51-min "wait" on a queue that had
 *  advanced 4 min earlier). */
export const DUE_BACKLOG_LIMIT_MS = 15 * 60_000;
/** A lock held by a pool other than the live one. The worker reconciles
 *  these within a minute of boot, so five minutes means that self-heal is
 *  not working. */
export const STALE_LOCK_LIMIT_MS = 5 * 60_000;

export interface QueueHealthRows {
  /** Live pool id from `worker_heartbeat`; null if the worker never reported one. */
  livePoolId: string | null;
  /** Due+unlocked+retryable jobs, one row per queue (`null` = no named
   *  queue): how many, and seconds since the oldest one's `run_at`. */
  dueBacklog: Array<{ queueName: string | null; count: number; oldestSeconds: number }>;
  /** Every held lock, both queue rows and job rows. */
  locks: Array<{ kind: "queue" | "job"; name: string; lockedBy: string; ageSeconds: number }>;
  /** `clip_renders` that read as stalled under render-status.ts's rules. */
  stalledRenders: Array<{ id: string; status: string; ageSeconds: number }>;
}

export interface QueueHealth {
  ok: boolean;
  reasons: string[];
  checks: {
    /** Longest real wait: per queue, the oldest job's age, capped by how
     *  long a live-held serial queue has been on its current job. */
    oldestDueSeconds: number | null;
    dueLimitSeconds: number;
    dueBacklog: QueueHealthRows["dueBacklog"];
    livePoolId: string | null;
    staleLocks: QueueHealthRows["locks"];
    foreignLocks: QueueHealthRows["locks"];
    stalledRenders: QueueHealthRows["stalledRenders"];
  };
}

export function evaluateQueueHealth(rows: QueueHealthRows): QueueHealth {
  const reasons: string[] = [];
  let oldestDueSeconds: number | null = null;
  let worst: QueueHealthRows["dueBacklog"][number] | null = null;
  for (const b of rows.dueBacklog) {
    const liveQueueLock = b.queueName && rows.livePoolId
      ? rows.locks.find((l) => l.kind === "queue" && l.name === b.queueName && l.lockedBy === rows.livePoolId)
      : undefined;
    const waited = liveQueueLock ? Math.min(b.oldestSeconds, liveQueueLock.ageSeconds) : b.oldestSeconds;
    if (oldestDueSeconds === null || waited > oldestDueSeconds) {
      oldestDueSeconds = waited;
      worst = b;
    }
  }
  if (worst && oldestDueSeconds !== null && oldestDueSeconds * 1000 > DUE_BACKLOG_LIMIT_MS) {
    const where = worst.queueName ? ` on queue ${worst.queueName} (${worst.count} waiting)` : "";
    reasons.push(`a due job has waited ${Math.round(oldestDueSeconds / 60)} min without being picked up${where}`);
  }
  const foreignLocks = rows.livePoolId
    ? rows.locks.filter((l) => l.lockedBy !== rows.livePoolId)
    : [];
  const staleLocks = foreignLocks.filter((l) => l.ageSeconds * 1000 > STALE_LOCK_LIMIT_MS);
  if (staleLocks.length > 0) {
    reasons.push(
      `${staleLocks.length} lock(s) held by a dead worker for > ${STALE_LOCK_LIMIT_MS / 60_000} min: ` +
        staleLocks.map((l) => `${l.kind}:${l.name}@${l.lockedBy}`).join(", "),
    );
  }
  if (rows.stalledRenders.length > 0) {
    reasons.push(`${rows.stalledRenders.length} clip render(s) stalled`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    checks: {
      oldestDueSeconds,
      dueLimitSeconds: DUE_BACKLOG_LIMIT_MS / 1000,
      dueBacklog: rows.dueBacklog,
      livePoolId: rows.livePoolId,
      staleLocks,
      foreignLocks,
      stalledRenders: rows.stalledRenders,
    },
  };
}

export async function loadQueueHealthRows(): Promise<QueueHealthRows> {
  const [heartbeat, due, locks, renders] = await Promise.all([
    db.execute<{ pool_id: string | null }>(sql`
      select pool_id from worker_heartbeat where id = 'singleton' limit 1
    `),
    db.execute<{ queue_name: string | null; count: number; age_seconds: number }>(sql`
      select queue_name, count(*)::int as count,
             extract(epoch from now() - min(run_at))::int as age_seconds
        from graphile_worker.jobs
       where run_at <= now() and locked_at is null and attempts < max_attempts
       group by queue_name
    `),
    db.execute<{ kind: "queue" | "job"; name: string; locked_by: string; age_seconds: number }>(sql`
      select 'queue'::text as kind, q.queue_name as name, q.locked_by,
             extract(epoch from now() - q.locked_at)::int as age_seconds
        from graphile_worker._private_job_queues q where q.locked_by is not null
      union all
      select 'job'::text as kind, (j.id::text || ':' || t.identifier) as name, j.locked_by,
             extract(epoch from now() - j.locked_at)::int as age_seconds
        from graphile_worker._private_jobs j
        join graphile_worker._private_tasks t on t.id = j.task_id
       where j.locked_by is not null
    `),
    db.execute<{ id: string; status: string; age_seconds: number }>(sql`
      select id, status,
             extract(epoch from now() - coalesce(heartbeat_at, started_at, created_at))::int as age_seconds
        from clip_renders
       where (status = 'rendering'
              and coalesce(heartbeat_at, started_at, created_at) < now() - make_interval(secs => ${RENDER_STALL_MS / 1000}))
          or (status = 'queued'
              and created_at < now() - make_interval(secs => ${RENDER_QUEUE_STALL_MS / 1000}))
       order by created_at
    `),
  ]);
  const heartbeatRows = heartbeat as unknown as Array<{ pool_id: string | null }>;
  const dueRows = due as unknown as Array<{ queue_name: string | null; count: number; age_seconds: number }>;
  const lockRows = locks as unknown as Array<{ kind: "queue" | "job"; name: string; locked_by: string; age_seconds: number }>;
  const renderRows = renders as unknown as Array<{ id: string; status: string; age_seconds: number }>;
  return {
    livePoolId: heartbeatRows[0]?.pool_id ?? null,
    dueBacklog: dueRows.map((d) => ({ queueName: d.queue_name, count: d.count, oldestSeconds: d.age_seconds })),
    locks: lockRows.map((l) => ({ kind: l.kind, name: l.name, lockedBy: l.locked_by, ageSeconds: l.age_seconds })),
    stalledRenders: renderRows.map((r) => ({ id: r.id, status: r.status, ageSeconds: r.age_seconds })),
  };
}
