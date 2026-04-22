// Creates / migrates the `graphile_worker` schema. Runs in Heroku's release
// phase after `npm run db:migrate`, so by the time the worker dyno boots the
// queue tables exist.
//
// We hand graphile-worker a pre-built pg.Pool with explicit SSL config
// because Heroku Postgres requires it and its `connectionString` shortcut
// doesn't negotiate SSL automatically.
import pg from "pg";
import { runMigrations } from "graphile-worker";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };

const pgPool = new pg.Pool({ connectionString: url, ssl, max: 1 });

try {
  await runMigrations({ pgPool });
  console.log("graphile_worker migrations applied.");
} catch (err) {
  console.error("graphile-worker migration failed:", err);
  process.exit(1);
} finally {
  await pgPool.end();
}
