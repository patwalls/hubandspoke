/**
 * Dev tool: run the `design-frames` task for ONE design item in-process (no
 * graphile worker — see clip-editor-run-render.ts for why).
 *
 *   npx tsx --env-file=.env.local scripts/design-run-frames.ts <productionItemId> [atSec]
 */
import { eq } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";

async function main() {
  const { db } = await import("../src/lib/db");
  const { productionItems } = await import("../src/lib/db/schema");
  const { designFramesTask } = await import("../src/jobs/tasks/design-frames");
  const productionItemId = process.argv[2];
  if (!productionItemId) throw new Error("usage: design-run-frames.ts <productionItemId> [atSec]");
  const [item] = await db.select({ pillar: productionItems.pillarContentItemId }).from(productionItems).where(eq(productionItems.id, productionItemId)).limit(1);
  if (!item) throw new Error("item not found");
  const atSec = process.argv[3] ? Number(process.argv[3]) : undefined;
  const logger = { info: (m: string) => console.log("[info]", m), warn: (m: string) => console.warn("[warn]", m), error: (m: string) => console.error("[error]", m), debug: () => {} };
  await designFramesTask({ productionItemId, sourceItemId: item.pillar ?? productionItemId, ...(atSec !== undefined ? { atSec } : {}) }, { logger } as unknown as JobHelpers);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
