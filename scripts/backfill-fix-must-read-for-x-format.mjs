/**
 * One-shot cleanup: only posts whose title contains "must-bookmark" should
 * carry the "A Must Read For X" format. Everything else with that format
 * was mis-tagged (likely by `scripts/backfill-missing-formats.mjs` running
 * the LLM classifier with the format list as a candidate set).
 *
 * Strategy:
 *   - Find every production_items row with format = "A Must Read For X"
 *     for the starter-story brand.
 *   - Keep it on rows whose title contains the literal "must-bookmark"
 *     (case-insensitive).
 *   - Null the format on every other row.
 *
 * Defaults to dry-run.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-fix-must-read-for-x-format.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-fix-must-read-for-x-format.mjs --apply
 */
import postgres from "postgres";

const FORMAT_NAME = "A Must Read For X";
const KEEP_PATTERN = /must-bookmark/i;
const BRAND = "starter-story";

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
  const rows = await sql`
    SELECT id, title
      FROM production_items
     WHERE brand = ${BRAND}
       AND format = ${FORMAT_NAME}
       AND deleted_at IS NULL
     ORDER BY published_at DESC NULLS LAST, created_at DESC
  `;

  const keep = [];
  const wipe = [];
  for (const r of rows) {
    if (r.title && KEEP_PATTERN.test(r.title)) keep.push(r);
    else wipe.push(r);
  }

  console.log(
    `Mode: ${dryRun ? "DRY RUN" : "APPLY"} · brand=${BRAND} · format="${FORMAT_NAME}"`
  );
  console.log(`  Total rows tagged: ${rows.length}`);
  console.log(`  Keeping (title matches /must-bookmark/i): ${keep.length}`);
  console.log(`  Will null format on the other ${wipe.length} rows.`);

  if (keep.length > 0) {
    console.log(`\nKeeping:`);
    for (const r of keep) {
      console.log(`  ✓ ${r.id}  ${truncate(r.title, 70)}`);
    }
  }
  if (wipe.length > 0) {
    console.log(`\nWill null format on:`);
    for (const r of wipe.slice(0, 50)) {
      console.log(`  ✗ ${r.id}  ${truncate(r.title, 70)}`);
    }
    if (wipe.length > 50) {
      console.log(`  … and ${wipe.length - 50} more`);
    }
  }

  if (dryRun || wipe.length === 0) {
    if (dryRun) console.log(`\nDRY RUN — pass --apply to commit.`);
    await sql.end();
    return;
  }

  const ids = wipe.map((r) => r.id);
  const result = await sql`
    UPDATE production_items
       SET format = NULL,
           updated_at = NOW()
     WHERE id IN ${sql(ids)}
       AND brand = ${BRAND}
       AND format = ${FORMAT_NAME}
  `;

  console.log(`\nNulled format on ${result.count} row${result.count === 1 ? "" : "s"}.`);
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
