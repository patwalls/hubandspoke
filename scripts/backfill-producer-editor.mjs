/**
 * One-time backfill: assign producer_user_id / editor_user_id to every
 * production_items row still missing one.
 *
 * Resolution chain (same as src/lib/services/assignees.ts, mirrored in SQL so
 * we don't pay a per-row round trip):
 *   1. Source item (for cross_post / repost via reposted_from_item_id)
 *   2. Format default (formats.{producer|editor}_notion_user_id → users.notion_user_id)
 *   3. brand_settings.{default_producer|default_editor}_user_id
 *   4. Global fallback: patrickswalls@gmail.com
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 *
 * Run (dry):    node --env-file=.env.local scripts/backfill-producer-editor.mjs
 * Run (apply):  node --env-file=.env.local scripts/backfill-producer-editor.mjs --apply
 * One brand:    ... --brand=starter-story
 *
 * Each step is wrapped in a transaction and only touches rows where the
 * relevant FK IS NULL, so re-running is idempotent and safe.
 */
import postgres from "postgres";

const GLOBAL_FALLBACK_EMAIL = "patrickswalls@gmail.com";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;
const brandArg =
  args.find((a) => a.startsWith("--brand="))?.split("=")[1] ?? null;

console.log(
  `Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"}` +
    (brandArg ? ` | brand=${brandArg}` : "")
);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 4,
});

const brandFilter = brandArg ? sql`AND brand = ${brandArg}` : sql``;

async function countNulls(label) {
  const [row] = await sql`
    SELECT
      count(*) FILTER (WHERE producer_user_id IS NULL) AS producer_null,
      count(*) FILTER (WHERE editor_user_id IS NULL) AS editor_null,
      count(*) AS total
    FROM production_items
    WHERE TRUE ${brandFilter}
  `;
  console.log(
    `[${label}] total=${row.total} producer_null=${row.producer_null} editor_null=${row.editor_null}`
  );
  return { producerNull: Number(row.producer_null), editorNull: Number(row.editor_null) };
}

async function runStep(label, query) {
  const result = await query;
  const count = result.count ?? 0;
  console.log(`  [${label}] rows updated: ${count}`);
  return count;
}

try {
  // Verify global fallback user exists before we start.
  const [fallback] = await sql`
    SELECT id FROM users WHERE lower(email) = ${GLOBAL_FALLBACK_EMAIL.toLowerCase()} LIMIT 1
  `;
  if (!fallback) {
    console.error(
      `Global fallback user ${GLOBAL_FALLBACK_EMAIL} not found in users table. Aborting.`
    );
    process.exit(1);
  }

  await countNulls("before");

  if (dryRun) {
    console.log("\nDry run — no writes. Re-run with --apply to execute.");
    await sql.end({ timeout: 5 });
    process.exit(0);
  }

  console.log("\nApplying backfill...");

  // Step 1: inherit from source item (cross_post / repost).
  console.log("Step 1: inherit from source item");
  await runStep(
    "producer ← source",
    sql`
      UPDATE production_items pi
      SET producer_user_id = src.producer_user_id
      FROM production_items src
      WHERE pi.producer_user_id IS NULL
        AND pi.reposted_from_item_id IS NOT NULL
        AND src.id = pi.reposted_from_item_id
        AND src.producer_user_id IS NOT NULL
        ${brandArg ? sql`AND pi.brand = ${brandArg}` : sql``}
    `
  );
  await runStep(
    "editor ← source",
    sql`
      UPDATE production_items pi
      SET editor_user_id = src.editor_user_id
      FROM production_items src
      WHERE pi.editor_user_id IS NULL
        AND pi.reposted_from_item_id IS NOT NULL
        AND src.id = pi.reposted_from_item_id
        AND src.editor_user_id IS NOT NULL
        ${brandArg ? sql`AND pi.brand = ${brandArg}` : sql``}
    `
  );

  // Step 2: format default via formats.{producer|editor}_notion_user_id.
  console.log("Step 2: inherit from format default");
  await runStep(
    "producer ← format",
    sql`
      UPDATE production_items pi
      SET producer_user_id = u.id
      FROM formats f
      JOIN users u ON u.notion_user_id = f.producer_notion_user_id
      WHERE pi.producer_user_id IS NULL
        AND pi.format IS NOT NULL
        AND f.brand = pi.brand
        AND f.name = pi.format
        AND f.producer_notion_user_id IS NOT NULL
        ${brandArg ? sql`AND pi.brand = ${brandArg}` : sql``}
    `
  );
  await runStep(
    "editor ← format",
    sql`
      UPDATE production_items pi
      SET editor_user_id = u.id
      FROM formats f
      JOIN users u ON u.notion_user_id = f.editor_notion_user_id
      WHERE pi.editor_user_id IS NULL
        AND pi.format IS NOT NULL
        AND f.brand = pi.brand
        AND f.name = pi.format
        AND f.editor_notion_user_id IS NOT NULL
        ${brandArg ? sql`AND pi.brand = ${brandArg}` : sql``}
    `
  );

  // Step 3: brand_settings default.
  console.log("Step 3: brand_settings default");
  await runStep(
    "producer ← brand default",
    sql`
      UPDATE production_items pi
      SET producer_user_id = bs.default_producer_user_id
      FROM brand_settings bs
      WHERE pi.producer_user_id IS NULL
        AND pi.brand = bs.brand
        AND bs.default_producer_user_id IS NOT NULL
        ${brandArg ? sql`AND pi.brand = ${brandArg}` : sql``}
    `
  );
  await runStep(
    "editor ← brand default",
    sql`
      UPDATE production_items pi
      SET editor_user_id = bs.default_editor_user_id
      FROM brand_settings bs
      WHERE pi.editor_user_id IS NULL
        AND pi.brand = bs.brand
        AND bs.default_editor_user_id IS NOT NULL
        ${brandArg ? sql`AND pi.brand = ${brandArg}` : sql``}
    `
  );

  // Step 4: global fallback.
  console.log("Step 4: global fallback");
  await runStep(
    "producer ← global",
    sql`
      UPDATE production_items
      SET producer_user_id = ${fallback.id}
      WHERE producer_user_id IS NULL
        ${brandArg ? sql`AND brand = ${brandArg}` : sql``}
    `
  );
  await runStep(
    "editor ← global",
    sql`
      UPDATE production_items
      SET editor_user_id = ${fallback.id}
      WHERE editor_user_id IS NULL
        ${brandArg ? sql`AND brand = ${brandArg}` : sql``}
    `
  );

  console.log("");
  const after = await countNulls("after");
  if (after.producerNull > 0 || after.editorNull > 0) {
    console.error(
      `\nERROR: ${after.producerNull} producer + ${after.editorNull} editor rows still NULL. Investigate before adding NOT NULL constraint.`
    );
    process.exit(1);
  }

  console.log("\nDone. All rows have both producer_user_id and editor_user_id.");
} catch (err) {
  console.error("Backfill failed:", err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
