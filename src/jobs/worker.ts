// Worker dyno entrypoint. Ran by `npm run worker` (declared in Procfile).
//
// Connects to Postgres, runs the task list, and handles SIGTERM gracefully so
// in-flight jobs finish before Heroku SIGKILLs us at the 30s mark.

import { run } from "graphile-worker";
import { taskList } from "./tasks";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const runner = await run({
    connectionString,
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
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(`[worker] started concurrency=4 tasks=${Object.keys(taskList).join(",")}`);

  await runner.promise;
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
