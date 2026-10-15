// Who this worker process is, as graphile-worker sees it. Filled in by
// worker.ts from the runner's events and read by the lock reconciler and
// the `worker-heartbeat` task (which publishes the pool id so the web
// dyno's /api/health/queue can tell a live lock from an orphaned one).
//
// graphile-worker ≥0.17 stamps `locked_by` with the POOL id (`pool-<hex>`,
// one per process boot), not the per-slot `worker-<hex>` ids that appear in
// log lines. A lock whose holder isn't this process's pool id can only be
// held by a process that no longer exists (Heroku stops the old worker dyno
// before starting the new one), which is what makes reconciliation safe.

export interface InFlightJob {
  id: string;
  taskIdentifier: string;
  /** `_private_job_queues.id` as text, for serial queues; null otherwise. */
  queueId: string | null;
  startedAt: Date;
}

const state: {
  poolId: string | null;
  bootAt: Date;
  inFlight: Map<string, InFlightJob>;
} = {
  poolId: null,
  bootAt: new Date(),
  inFlight: new Map(),
};

export function setPoolId(poolId: string): void {
  state.poolId = poolId;
}

export function getPoolId(): string | null {
  return state.poolId;
}

export function getBootAt(): Date {
  return state.bootAt;
}

export function markJobStarted(job: InFlightJob): void {
  state.inFlight.set(job.id, job);
}

export function markJobFinished(jobId: string): void {
  state.inFlight.delete(jobId);
}

export function getInFlightJobs(): InFlightJob[] {
  return [...state.inFlight.values()];
}

/** Test seam. */
export function _resetWorkerIdentityForTests(bootAt = new Date()): void {
  state.poolId = null;
  state.bootAt = bootAt;
  state.inFlight.clear();
}
