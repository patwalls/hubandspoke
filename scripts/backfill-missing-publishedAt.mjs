/**
 * One-shot backfill: set `published_at = created_at` for any Published
 * original row that has a null `published_at`.
 *
 * These are legacy items from before `publishedAt` was consistently
 * stamped on insert. They're silently invisible to velocity tracking
 * (`scheduleVelocitySnapshots` no-ops on null) and to the cross-post
 * scanner's candidate pool (`publishedAt` gate). `created_at` is the
 * best approximation we have of the real publish moment.
 *
 * Safe to run repeatedly — a row that already has `published_at` is
 * left alone.
 *
 * Defaults to dry-run. Pass --apply to commit.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-missing-publishedAt.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-missing-publishedAt.mjs --apply
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
  const candidates = await sql`
    SELECT id, title, brand, created_at
      FROM production_items
     WHERE status = 'Published'
       AND source_type = 'original'
       AND deleted_at IS NULL
       AND published_at IS NULL
     ORDER BY created_at DESC
  `;

  console.log(
    `Found ${candidates.length} Published originals with null published_at. Mode: ${
      dryRun ? "DRY RUN" : "APPLY"
    }.`
  );
  for (const c of candidates) {
    console.log(
      `  ${c.id}  ${c.brand.padEnd(20)}  created=${c.created_at.toISOString()}  ${(c.title ?? "").slice(0, 60)}`
    );
  }

  if (candidates.length === 0 || dryRun) {
    if (dryRun && candidates.length > 0) {
      console.log("");
      console.log("Dry run — nothing written. Pass --apply to commit.");
    }
    await sql.end();
    return;
  }

  const updated = await sql`
    UPDATE production_items
       SET published_at = created_at,
           updated_at = now()
     WHERE status = 'Published'
       AND source_type = 'original'
       AND deleted_at IS NULL
       AND published_at IS NULL
    RETURNING id
  `;
  console.log("");
  console.log(`Updated ${updated.length} rows.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
