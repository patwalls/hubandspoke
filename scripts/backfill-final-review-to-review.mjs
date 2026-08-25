/**
 * Migrates all production items in "Final Review" status to "Review",
 * then removes the "Final Review" status from every brand's status list.
 *
 * Run BEFORE deploying the code that removes Final Review from the UI.
 *
 *   node --env-file=.env.local scripts/backfill-final-review-to-review.mjs
 *   node --env-file=.env.local scripts/backfill-final-review-to-review.mjs --apply
 *
 * On Heroku:
 *   heroku run --app=hubandspoke node scripts/backfill-final-review-to-review.mjs
 *   heroku run --app=hubandspoke node scripts/backfill-final-review-to-review.mjs --apply
 */
import postgres from "postgres";

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
  // Count and preview items that will move.
  const candidates = await sql`
    SELECT id, brand, format, title, created_at
      FROM production_items
     WHERE status = 'Final Review'
       AND deleted_at IS NULL
     ORDER BY brand, created_at DESC
  `;

  console.log(`\nFound ${candidates.length} item(s) in "Final Review":`);
  for (const c of candidates) {
    console.log(
      `  [${c.brand}] ${c.format || "(no format)"} — ${(c.title || "(untitled)").slice(0, 80)}`
    );
  }

  const statusRows = await sql`
    SELECT bs.id, bs.brand_id, b.slug AS brand_slug
      FROM brand_statuses bs
      JOIN brands b ON b.id = bs.brand_id
     WHERE bs.name = 'Final Review'
  `;
  console.log(
    `\nFound ${statusRows.length} brand_statuses row(s) for "Final Review": ${statusRows.map((r) => r.brand_slug).join(", ") || "(none)"}`
  );

  console.log(`\nMode: ${dryRun ? "DRY RUN (pass --apply to commit)" : "APPLY"}\n`);

  if (dryRun) {
    console.log("Would UPDATE production_items: Final Review → Review");
    console.log("Would DELETE brand_statuses WHERE name = 'Final Review'");
    await sql.end();
    return;
  }

  const updated = await sql`
    UPDATE production_items
       SET status = 'Review',
           updated_at = NOW()
     WHERE status = 'Final Review'
       AND deleted_at IS NULL
  `;
  console.log(`Updated ${updated.count} production_item(s): Final Review → Review`);

  const deleted = await sql`
    DELETE FROM brand_statuses WHERE name = 'Final Review'
  `;
  console.log(`Deleted ${deleted.count} brand_statuses row(s) for "Final Review"`);

  console.log("\nDone. No content was deleted.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
