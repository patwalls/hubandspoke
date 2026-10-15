// Self-healing for graphile-worker's lock bookkeeping.
//
// Why this exists (2026-10-15): the serial `media-heavy` queue wedged three
// times in one day. Each time `_private_job_queues.media-heavy` (and
// sometimes a job row) stayed locked by a pool id whose process was gone —
// a deploy restart, an unexplained dyno boot, or a fetch whose
// acknowledgement never reached the worker. graphile only reclaims such a
// lock after 4h, and a locked named queue blocks EVERY job behind it, so
// every clip/design render sat "queued" until a human ran
// `force_unlock_workers`. The ops lap's DB role is read-only, so it could
// only page Pat.
//
// Two cases, both decided by `classifyLocks` (pure, unit-tested):
//
//   1. ORPHAN — holder is not this process's pool id AND the lock predates
//      this process's boot. Heroku never runs two worker dynos for the same
//      formation during a restart (old stops, then new starts), so such a
//      holder cannot be alive. → `graphile_worker.force_unlock_workers`.
//
//   2. GHOST — holder IS this pool, the lock is older than the grace period,
//      and the job isn't in our in-memory in-flight set (fed by the runner's
//      job:start/job:complete events). The DB thinks we're running it; we
//      aren't. → clear that row's lock (and its queue's) directly.
//
// Anything else (a foreign holder with a lock newer than our boot — a
// second worker, a one-off dyno, a local `npm run worker` against prod) is
// left alone and reported, never touched.
//
// Runs at boot and every RECONCILE_INTERVAL_MS from worker.ts. Also the
// reason `/api/health/queue` treats a stale foreign lock as CRIT: if one
// survives more than a couple of minutes, this code is broken.

import type { Pool } from "pg";

export const RECONCILE_INTERVAL_MS = 60_000;
/** A job we locked but never started within this window is a ghost. Covers
 *  the fetch→start window with two orders of magnitude to spare. */
export const GHOST_GRACE_MS = 2 * 60_000;

export interface LockRow {
  kind: "queue" | "job";
  /** `_private_job_queues.id` or `_private_jobs.id`, as text. */
  id: string;
  queueName: string | null;
  lockedBy: string;
  lockedAt: Date;
}

export interface ClassifyInput {
  rows: LockRow[];
  selfPoolId: string;
  bootAt: Date;
  /** Job ids this process is executing right now. */
  inFlightJobIds: Set<string>;
  /** `_private_job_queues.id`s (as text) those in-flight jobs belong to. */
  inFlightQueueIds: Set<string>;
  now?: Date;
  ghostGraceMs?: number;
}

export interface Classification {
  /** Dead holders → force_unlock_workers. */
  orphanHolders: string[];
  /** Our own locks on jobs we aren't running → clear. */
  ghostJobIds: string[];
  /** Our own queue locks with no in-flight job in that queue → clear. */
  ghostQueueIds: string[];
  /** Foreign holders newer than our boot — someone else is alive. Report only. */
  foreignLiveHolders: string[];
}

export function classifyLocks(input: ClassifyInput): Classification {
  const now = input.now ?? new Date();
  const grace = input.ghostGraceMs ?? GHOST_GRACE_MS;
  const orphan = new Set<string>();
  const foreignLive = new Set<string>();
  const ghostJobIds: string[] = [];
  const ghostQueueIds: string[] = [];

  for (const row of input.rows) {
    if (row.lockedBy !== input.selfPoolId) {
      if (row.lockedAt.getTime() < input.bootAt.getTime()) orphan.add(row.lockedBy);
      else foreignLive.add(row.lockedBy);
      continue;
    }
    if (now.getTime() - row.lockedAt.getTime() < grace) continue;
    if (row.kind === "job") {
      if (!input.inFlightJobIds.has(row.id)) ghostJobIds.push(row.id);
    } else if (!input.inFlightQueueIds.has(row.id)) {
      ghostQueueIds.push(row.id);
    }
  }

  return {
    orphanHolders: [...orphan].sort(),
    ghostJobIds,
    ghostQueueIds,
    foreignLiveHolders: [...foreignLive].sort(),
  };
}

export async function fetchLockRows(pool: Pool): Promise<LockRow[]> {
  const { rows } = await pool.query<{
    kind: "queue" | "job";
    id: string;
    queue_name: string | null;
    locked_by: string;
    locked_at: Date;
  }>(`
    select 'queue'::text as kind, q.id::text as id, q.queue_name, q.locked_by, q.locked_at
      from graphile_worker._private_job_queues q
     where q.locked_by is not null
    union all
    select 'job'::text as kind, j.id::text as id, q.queue_name, j.locked_by, j.locked_at
      from graphile_worker._private_jobs j
      left join graphile_worker._private_job_queues q on q.id = j.job_queue_id
     where j.locked_by is not null
  `);
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    queueName: r.queue_name,
    lockedBy: r.locked_by,
    lockedAt: r.locked_at,
  }));
}

export interface ReconcileResult extends Classification {
  /** True when any lock was actually cleared. */
  acted: boolean;
}

export interface ReconcileDeps {
  pool: Pool;
  selfPoolId: string;
  bootAt: Date;
  inFlight: Array<{ id: string; queueId: string | null }>;
  now?: Date;
  ghostGraceMs?: number;
}

/**
 * One reconcile pass. Reads every held lock, classifies, clears what is
 * provably dead, and returns what it did so the caller can log/alert.
 */
export async function reconcileLocks(deps: ReconcileDeps): Promise<ReconcileResult> {
  const rows = await fetchLockRows(deps.pool);
  const inFlightQueueIds = [
    ...new Set(deps.inFlight.map((j) => j.queueId).filter((q): q is string => !!q)),
  ];
  const classification = classifyLocks({
    rows,
    selfPoolId: deps.selfPoolId,
    bootAt: deps.bootAt,
    inFlightJobIds: new Set(deps.inFlight.map((j) => j.id)),
    inFlightQueueIds: new Set(inFlightQueueIds),
    now: deps.now,
    ghostGraceMs: deps.ghostGraceMs,
  });

  let acted = false;
  if (classification.orphanHolders.length > 0) {
    await deps.pool.query(`select graphile_worker.force_unlock_workers($1::text[])`, [
      classification.orphanHolders,
    ]);
    acted = true;
  }
  if (classification.ghostJobIds.length > 0) {
    // Release the queue rows those jobs hold first, then the jobs. Both are
    // guarded by `locked_by = our pool` so a job we DID start in the meantime
    // is untouched, and a queue that still has one of OUR in-flight jobs in
    // it stays locked (a serial queue holds one job at a time in prod, but
    // never rely on it).
    await deps.pool.query(
      `update graphile_worker._private_job_queues q
          set locked_by = null, locked_at = null
        where q.locked_by = $2
          and q.id <> all($3::int[])
          and q.id in (select job_queue_id from graphile_worker._private_jobs
                        where id = any($1::bigint[]) and locked_by = $2)`,
      [classification.ghostJobIds, deps.selfPoolId, inFlightQueueIds],
    );
    await deps.pool.query(
      `update graphile_worker._private_jobs
          set locked_by = null, locked_at = null
        where id = any($1::bigint[]) and locked_by = $2`,
      [classification.ghostJobIds, deps.selfPoolId],
    );
    acted = true;
  }
  if (classification.ghostQueueIds.length > 0) {
    await deps.pool.query(
      `update graphile_worker._private_job_queues
          set locked_by = null, locked_at = null
        where id = any($1::int[]) and locked_by = $2`,
      [classification.ghostQueueIds, deps.selfPoolId],
    );
    acted = true;
  }
  return { ...classification, acted };
}
