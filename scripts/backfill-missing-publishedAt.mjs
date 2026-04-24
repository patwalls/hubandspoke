/**
 * One-shot backfill for legacy Published originals with a null
 * `published_at` timestamp.
 *
 * Sources, in priority order:
 *   1. `published_date` (the date-only field, set by Notion sync and
 *      older ingestion paths). Treated as midnight UTC of that date —
 *      approximate, but better than `created_at` which reflects when
 *      our app *learned* about the post, not when it went live.
 *   2. `created_at` (last resort, for rows with neither published_at
 *      nor published_date).
 *
 * These rows are silently invisible to velocity tracking
 * (`scheduleVelocitySnapshots` no-ops on null) and to the cross-post
 * scanner's 72h candidate gate. Almost all of them are old enough that
 * the velocity windows have long closed — the fix is primarily about
 * data hygiene, not retroactive capture.
 *
 * Safe to run repeatedly — rows that already have `published_at` are
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
    SELECT id, title, brand, created_at, published_date
      FROM production_items
     WHERE status = 'Published'
       AND source_type = 'original'
       AND deleted_at IS NULL
       AND published_at IS NULL
     ORDER BY COALESCE(published_date, created_at::date) DESC
  `;

  let withDate = 0;
  let withoutDate = 0;
  for (const c of candidates) {
    if (c.published_date) withDate++;
    else withoutDate++;
  }

  console.log(
    `Found ${candidates.length} Published originals with null published_at.`
  );
  console.log(
    `  ${withDate} have published_date → will use midnight of that date.`
  );
  console.log(
    `  ${withoutDate} have neither → will fall back to created_at.`
  );
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}.`);
  console.log("");

  // Show a small sample so the operator can sanity-check.
  const sample = candidates.slice(0, 5);
  for (const c of sample) {
    const source = c.published_date
      ? `published_date=${c.published_date.toISOString().slice(0, 10)}`
      : `created_at=${c.created_at.toISOString()}`;
    console.log(
      `  ${c.id}  ${c.brand.padEnd(20)}  ${source}  ${(c.title ?? "").slice(0, 60)}`
    );
  }
  if (candidates.length > sample.length) {
    console.log(`  … and ${candidates.length - sample.length} more.`);
  }

  if (candidates.length === 0 || dryRun) {
    if (dryRun && candidates.length > 0) {
      console.log("");
      console.log("Dry run — nothing written. Pass --apply to commit.");
    }
    await sql.end();
    return;
  }

  // Single UPDATE — COALESCE picks published_date (cast to timestamp at
  // midnight UTC) when present, otherwise created_at.
  const updated = await sql`
    UPDATE production_items
       SET published_at = COALESCE(published_date::timestamptz, created_at),
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
