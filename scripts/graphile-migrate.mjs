// Creates / migrates the `graphile_worker` schema. Runs in Heroku's release
// phase after `npm run db:migrate`, so by the time the worker dyno boots the
// queue tables exist. Matches the style of scripts/migrate.mjs.
import { runMigrations } from "graphile-worker";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

try {
  await runMigrations({ connectionString: url });
  console.log("graphile_worker migrations applied.");
} catch (err) {
  console.error("graphile-worker migration failed:", err);
  process.exit(1);
}
