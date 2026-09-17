/**
 * Dev tool: run the `clip-render` task for ONE render row, in-process,
 * without a graphile worker.
 *
 *   npx tsx --env-file=.env.local scripts/clip-editor-run-render.ts <renderId|latest>
 *
 * Why this exists: a local `npm run worker` against a /pulldb'd database will
 * start executing every queued prod job and every cron (syncs, emails,
 * scheduled publishes) against real APIs. This runs exactly one render and
 * nothing else. Needs S3 credentials in the environment.
 */
import { desc } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";

async function main() {
  const { db } = await import("../src/lib/db");
  const { clipRenders } = await import("../src/lib/db/schema");
  const { clipRenderTask } = await import("../src/jobs/tasks/clip-render");

  let renderId = process.argv[2];
  if (!renderId || renderId === "latest") {
    const [row] = await db
      .select({ id: clipRenders.id })
      .from(clipRenders)
      .orderBy(desc(clipRenders.createdAt))
      .limit(1);
    if (!row) throw new Error("No clip_renders rows");
    renderId = row.id;
  }
  const logger = {
    info: (m: string) => console.log("[info]", m),
    warn: (m: string) => console.warn("[warn]", m),
    error: (m: string) => console.error("[error]", m),
    debug: () => {},
  };
  await clipRenderTask({ renderId }, { logger } as unknown as JobHelpers);
  console.log("done", renderId);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
