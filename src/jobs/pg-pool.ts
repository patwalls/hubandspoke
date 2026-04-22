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
  return new Pool({
    connectionString,
    ssl,
    ...overrides,
  });
}
