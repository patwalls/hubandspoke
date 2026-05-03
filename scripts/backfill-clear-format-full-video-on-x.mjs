/**
 * One-shot cleanup: every post currently tagged with the format
 * `7b446965-43b5-4c43-bc27-04bc936af9bb` ("Full Video On X (SS Build)")
 * was mis-categorized — none of those posts actually represent that
 * format. This nulls `production_items.format` on each.
 *
 * Resolves the format name from the formats table at runtime so
 * production_items rows match correctly even if the name has been
 * edited (production_items.format is a text name, not an FK).
 *
 * Defaults to dry-run.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-clear-format-full-video-on-x.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-clear-format-full-video-on-x.mjs --apply
 */
import postgres from "postgres";

const FORMAT_ID = "7b446965-43b5-4c43-bc27-04bc936af9bb";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

async function main() {
  const [fmt] = await sql`
    SELECT id, name, brand FROM formats WHERE id = ${FORMAT_ID}
  `;
  if (!fmt) {
    console.error(`Format ${FORMAT_ID} not found.`);
    await sql.end();
    process.exit(1);
  }

  const rows = await sql`
    SELECT id, title, published_at
      FROM production_items
     WHERE brand = ${fmt.brand}
       AND format = ${fmt.name}
       AND deleted_at IS NULL
     ORDER BY published_at DESC NULLS LAST, created_at DESC
  `;

  console.log(
    `Mode: ${dryRun ? "DRY RUN" : "APPLY"} · brand=${fmt.brand} · format="${fmt.name}" (${fmt.id})`
  );
  console.log(`  Rows that will have format cleared: ${rows.length}`);

  if (rows.length > 0) {
    console.log(`\nSample (first 50):`);
    for (const r of rows.slice(0, 50)) {
      console.log(`  ✗ ${r.id}  ${truncate(r.title, 70)}`);
    }
    if (rows.length > 50) {
      console.log(`  … and ${rows.length - 50} more`);
    }
  }

  if (dryRun || rows.length === 0) {
    if (dryRun) console.log(`\nDRY RUN — pass --apply to commit.`);
    await sql.end();
    return;
  }

  const ids = rows.map((r) => r.id);
  const result = await sql`
    UPDATE production_items
       SET format = NULL,
           updated_at = NOW()
     WHERE id IN ${sql(ids)}
       AND brand = ${fmt.brand}
       AND format = ${fmt.name}
  `;

  console.log(
    `\nCleared format on ${result.count} row${result.count === 1 ? "" : "s"}.`
  );
  await sql.end();
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
