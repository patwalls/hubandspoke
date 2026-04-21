/**
 * Delete a format and every production_items row that uses it.
 *
 * One-shot cleanup for retiring a format. Refuses to run if the format has
 * child formats in the repurpose tree — subtrees must be handled explicitly
 * to avoid accidentally wiping unrelated descendants.
 *
 * Cascades handled automatically by FK ON DELETE:
 *   - content_comments, content_events, notifications → CASCADE
 *   - pillar_content_item_id / reposted_from_item_id  → SET NULL on other rows
 * Cleared explicitly (no CASCADE on these FKs):
 *   - repurpose_triggers rows that reference the deleted items or the format
 *
 * Usage:
 *   DATABASE_URL="$(heroku config:get DATABASE_URL --app=hubandspoke)" \
 *     node scripts/delete-format.mjs <format-id>            # dry run
 *
 *   DATABASE_URL="..." node scripts/delete-format.mjs <format-id> --apply
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;
const formatId = args.find((a) => !a.startsWith("--"));

if (!formatId) {
  console.error("Usage: node scripts/delete-format.mjs <format-id> [--apply]");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: connectionString.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  const [format] = await sql`
    SELECT id, name, brand, parent_format_id
    FROM formats
    WHERE id = ${formatId}
  `;
  if (!format) {
    console.error(`No format with id ${formatId}.`);
    process.exit(1);
  }

  const children = await sql`
    SELECT id, name FROM formats WHERE parent_format_id = ${formatId}
  `;
  if (children.length > 0) {
    console.error(
      `Format "${format.name}" has ${children.length} child format(s) in the repurpose tree:`
    );
    for (const c of children) console.error(`  - ${c.name} (${c.id})`);
    console.error(
      "Refusing to run. Reparent or delete the children first, then retry."
    );
    process.exit(1);
  }

  const items = await sql`
    SELECT id, title, status, source_type
    FROM production_items
    WHERE format = ${format.name} AND brand = ${format.brand}
  `;

  const statusBreakdown = items.reduce((acc, i) => {
    acc[i.status ?? "(null)"] = (acc[i.status ?? "(null)"] ?? 0) + 1;
    return acc;
  }, {});

  const itemIds = items.map((i) => i.id);

  const [{ count: triggerCount }] = itemIds.length
    ? await sql`
        SELECT COUNT(*)::int AS count FROM repurpose_triggers
        WHERE production_item_id = ANY(${itemIds})
           OR source_format_id = ${formatId}
           OR target_format_id = ${formatId}
      `
    : await sql`
        SELECT COUNT(*)::int AS count FROM repurpose_triggers
        WHERE source_format_id = ${formatId} OR target_format_id = ${formatId}
      `;

  console.log(`Format:  ${format.name}  (${format.id})`);
  console.log(`Brand:   ${format.brand}`);
  console.log(`Mode:    ${dryRun ? "DRY RUN (use --apply to delete)" : "APPLY"}\n`);
  console.log(`Production items using this format: ${items.length}`);
  for (const [status, n] of Object.entries(statusBreakdown).sort()) {
    console.log(`  ${status}: ${n}`);
  }
  console.log(`repurpose_triggers to clear: ${triggerCount}`);
  console.log("");

  if (dryRun) {
    console.log(
      `Would delete ${items.length} production_items + ${triggerCount} repurpose_triggers + 1 format row.`
    );
    console.log("Re-run with --apply to execute.");
    await sql.end();
    return;
  }

  await sql.begin(async (tx) => {
    if (triggerCount > 0) {
      if (itemIds.length) {
        await tx`
          DELETE FROM repurpose_triggers
          WHERE production_item_id = ANY(${itemIds})
             OR source_format_id = ${formatId}
             OR target_format_id = ${formatId}
        `;
      } else {
        await tx`
          DELETE FROM repurpose_triggers
          WHERE source_format_id = ${formatId} OR target_format_id = ${formatId}
        `;
      }
    }

    if (itemIds.length) {
      await tx`
        DELETE FROM production_items WHERE id = ANY(${itemIds})
      `;
    }

    await tx`DELETE FROM formats WHERE id = ${formatId}`;
  });

  console.log(
    `Deleted ${items.length} production_items, ${triggerCount} repurpose_triggers, and format "${format.name}".`
  );
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
