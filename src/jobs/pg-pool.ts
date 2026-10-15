import { Pool, type PoolConfig } from "pg";

/**
 * Build a `pg.Pool` with SSL config matching our Drizzle setup. Heroku
 * Postgres uses self-signed certs, so we disable cert verification; local dev
 * with `DATABASE_SSL=off` skips SSL entirely.
 *
 * Used everywhere we hand a pool to graphile-worker (worker runtime,
 * enqueue-side WorkerUtils, release-phase migrations).
 */
export function buildPgPool(overrides: Partial<PoolConfig> = {}): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL not set");
  }
  const ssl =
    process.env.DATABASE_SSL === "off"
      ? false
      : { rejectUnauthorized: false };
  const pool = new Pool({
    connectionString,
    ssl,
    ...overrides,
  });
  // An idle pooled client that loses its connection (Heroku Postgres
  // maintenance, a network blip) emits 'error' on the pool. With no listener
  // that is an uncaught exception → the whole dyno dies mid-job and leaves
  // graphile locks behind (graphile-worker 0.18 warns about exactly this at
  // boot: "Your pool doesn't have error handlers!"). Log it and carry on; the
  // pool discards the broken client on its own.
  pool.on("error", (err) => {
    console.error(`[pg-pool] idle client error: ${err.message}`);
  });
  return pool;
}
