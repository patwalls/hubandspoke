import { describe, it, expect, afterEach } from "vitest";
import { buildPgPool } from "./pg-pool";
import { reconcileLocks } from "./lock-reconcile";

// Exercises the real graphile_worker tables in the local DB. Fixtures are a
// private `hello` job in a throwaway named queue, locked by hand to mimic
// the three states the worker meets in prod.

const pool = buildPgPool({ max: 2 });
const queueName = `test-reconcile-${Math.random().toString(16).slice(2, 10)}`;
const createdJobIds: string[] = [];

async function addLockedJob(lockedBy: string, lockedAt: Date): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `select id::text from graphile_worker.add_job('hello', '{"message":"reconcile-test"}'::json, queue_name => $1)`,
    [queueName],
  );
  const id = rows[0].id;
  createdJobIds.push(id);
  await pool.query(
    `update graphile_worker._private_jobs set locked_by = $2, locked_at = $3 where id = $1::bigint`,
    [id, lockedBy, lockedAt],
  );
  await pool.query(
    `update graphile_worker._private_job_queues set locked_by = $2, locked_at = $3 where queue_name = $1`,
    [queueName, lockedBy, lockedAt],
  );
  return id;
}

async function queueId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `select id::text from graphile_worker._private_job_queues where queue_name = $1`,
    [queueName],
  );
  return rows[0].id;
}

async function lockState() {
  const job = await pool.query<{ locked_by: string | null }>(
    `select locked_by from graphile_worker._private_jobs where id = any($1::bigint[])`,
    [createdJobIds],
  );
  const queue = await pool.query<{ locked_by: string | null }>(
    `select locked_by from graphile_worker._private_job_queues where queue_name = $1`,
    [queueName],
  );
  return { jobs: job.rows.map((r) => r.locked_by), queue: queue.rows[0]?.locked_by ?? null };
}

afterEach(async () => {
  await pool.query(`delete from graphile_worker._private_jobs where id = any($1::bigint[])`, [createdJobIds]);
  await pool.query(`delete from graphile_worker._private_job_queues where queue_name = $1`, [queueName]);
  createdJobIds.length = 0;
});

describe("reconcileLocks (graphile tables)", () => {
  it("force-unlocks a queue + job held by a pool that predates our boot", async () => {
    const lockedAt = new Date(Date.now() - 30 * 60_000);
    await addLockedJob("pool-dead-test", lockedAt);
    const result = await reconcileLocks({
      pool,
      selfPoolId: "pool-me-test",
      bootAt: new Date(Date.now() - 5 * 60_000),
      inFlight: [],
    });
    expect(result.orphanHolders).toEqual(["pool-dead-test"]);
    expect(result.acted).toBe(true);
    expect(await lockState()).toEqual({ jobs: [null], queue: null });
  });

  it("clears our own ghost lock but leaves a job we are actually running alone", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const ghost = await addLockedJob("pool-me-test", old);
    const running = await addLockedJob("pool-me-test", old);
    const result = await reconcileLocks({
      pool,
      selfPoolId: "pool-me-test",
      bootAt: new Date(Date.now() - 60 * 60_000),
      inFlight: [{ id: running, queueId: await queueId() }],
    });
    expect(result.ghostJobIds).toEqual([ghost]);
    // The queue is still legitimately ours: `running` is in flight in it.
    expect(result.ghostQueueIds).toEqual([]);
    const state = await lockState();
    expect(state.jobs.filter((x) => x === "pool-me-test")).toHaveLength(1);
    expect(state.queue).toBe("pool-me-test");
  });

  it("leaves a foreign lock newer than our boot untouched and reports it", async () => {
    await addLockedJob("pool-other-live", new Date());
    const result = await reconcileLocks({
      pool,
      selfPoolId: "pool-me-test",
      bootAt: new Date(Date.now() - 60 * 60_000),
      inFlight: [],
    });
    expect(result.foreignLiveHolders).toEqual(["pool-other-live"]);
    expect(result.acted).toBe(false);
    expect((await lockState()).queue).toBe("pool-other-live");
  });
});
