// Worker dyno entrypoint. Ran by `npm run worker` (declared in Procfile).
//
// Connects to Postgres, runs the task list, and handles SIGTERM gracefully so
// in-flight jobs finish before Heroku SIGKILLs us at the 30s mark.

import { run } from "graphile-worker";
import { taskList } from "./tasks";
import { buildPgPool } from "./pg-pool";

async function main() {
  // Own pool with explicit SSL — Heroku Postgres requires it, and
  // graphile-worker's `connectionString` shortcut doesn't negotiate it.
  const pgPool = buildPgPool({ max: 6 });

  const runner = await run({
    pgPool,
    concurrency: 4,
    pollInterval: 2000,
    // Heroku sends SIGKILL 30s after SIGTERM; 20s of grace lets jobs finish
    // while leaving 10s of headroom for cleanup.
    gracefulShutdownAbortTimeout: 20_000,
    taskList,
  });

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received — shutting down gracefully`);
    await runner.stop();
    await pgPool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(
    `[worker] started concurrency=4 tasks=${Object.keys(taskList).join(",")}`
  );

  await runner.promise;
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
