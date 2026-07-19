/**
 * One-off: fire the Descript branch of the Draft Algorithm for a single
 * derivative item, bypassing the caption-regen step. Useful when an editor
 * clicked Redraft but the model provider is overloaded and the route bailed
 * before reaching the Descript step.
 *
 * Usage:
 *   heroku run --app hubandspoke npx tsx scripts/fire-descript-for-item.ts <itemId>
 *   # or locally:
 *   npx tsx --env-file=.env.local scripts/fire-descript-for-item.ts <itemId>
 *
 * Calls `runDescriptStepForDerivative` with `force=true`, so a previously
 * triggered or stale composition gets replaced. The helper handles the
 * skip cases (text-only pillar, pillar not in Descript, no skill) cleanly.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, productionItems } from "@/lib/db/schema";
import { runDescriptStepForDerivative } from "@/lib/services/draft-algorithm/descript-step";

async function main() {
  const itemId = process.argv[2];
  if (!itemId) {
    console.error("Usage: fire-descript-for-item <productionItemId>");
    process.exit(1);
  }

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      hook: productionItems.hook,
      brand: productionItems.brand,
      format: productionItems.format,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, itemId))
    .limit(1);

  if (!item) {
    console.error(`No production_item with id=${itemId}`);
    process.exit(2);
  }
  if (!item.format) {
    console.error(`Item ${itemId} has no format set`);
    process.exit(2);
  }

  const [fmt] = await db
    .select({
      id: formats.id,
      name: formats.name,
      instructions: formats.instructions,
      isClippableFormat: formats.isClippableFormat,
    })
    .from(formats)
    .where(and(eq(formats.brand, item.brand), eq(formats.name, item.format)))
    .limit(1);

  if (!fmt) {
    console.error(`Format not found for brand=${item.brand} name=${item.format}`);
    process.exit(2);
  }
  if (!fmt.isClippableFormat) {
    console.error(
      `Format "${fmt.name}" (id=${fmt.id}) is NOT flagged is_clippable_format — refusing to fire.`,
    );
    process.exit(2);
  }

  const compositionName =
    item.hook?.trim() ||
    item.title?.trim() ||
    `${item.format} (${item.id.slice(0, 8)})`;

  console.log(
    `Firing Descript step for item=${item.id} format="${fmt.name}" pillar=${item.pillarContentItemId ?? "<none>"} composition="${compositionName}"`,
  );

  const result = await runDescriptStepForDerivative({
    derivativeItemId: item.id,
    pillarItemId: item.pillarContentItemId ?? null,
    formatId: fmt.id,
    formatName: fmt.name,
    formatSkill: fmt.instructions,
    compositionName,
    force: true,
  });

  console.log("Result:", JSON.stringify(result));
  const ok =
    result.status === "triggered_warm" ||
    result.status === "triggered_cold_import";
  process.exit(ok ? 0 : 3);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
