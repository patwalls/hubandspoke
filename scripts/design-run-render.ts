/**
 * Dev tool: run the `design-render` task for ONE render row in-process (no
 * graphile worker — see clip-editor-run-render.ts for why).
 *
 *   npx tsx --env-file=.env.local scripts/design-run-render.ts <renderId|latest>
 */
import { desc } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";

async function main() {
  const { db } = await import("../src/lib/db");
  const { designRenders } = await import("../src/lib/db/schema");
  const { designRenderTask } = await import("../src/jobs/tasks/design-render");
  let renderId = process.argv[2];
  if (!renderId || renderId === "latest") {
    const [row] = await db.select({ id: designRenders.id }).from(designRenders).orderBy(desc(designRenders.createdAt)).limit(1);
    if (!row) throw new Error("No design_renders rows");
    renderId = row.id;
  }
  const logger = { info: (m: string) => console.log("[info]", m), warn: (m: string) => console.warn("[warn]", m), error: (m: string) => console.error("[error]", m), debug: () => {} };
  await designRenderTask({ renderId }, { logger } as unknown as JobHelpers);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
