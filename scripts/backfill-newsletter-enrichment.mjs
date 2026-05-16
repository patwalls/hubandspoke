/**
 * Backfill: re-enrich newsletters whose body HTML never landed.
 *
 * 146 newsletter rows in prod (as of 2026-05-15) have
 * `enrichment_completed_at IS NOT NULL` but `newsletter_body_html IS NULL` —
 * they predate the Klaviyo sync, so they never got `platform_content_id`
 * stamped, and the enricher short-circuited and marked them complete.
 *
 * The enricher now derives `platform_content_id` from the Klaviyo dashboard
 * URL on `published_link` when missing. For the 82 rows with a matching URL,
 * enqueue `enrich-item` with `force: true` so the orchestrator re-runs them
 * past the `enrichment_completed_at` gate.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-newsletter-enrichment.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-newsletter-enrichment.mjs --apply
 */
import postgres from "postgres";
import pg from "pg";
import { quickAddJob } from "graphile-worker";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const isLocal = databaseUrl.includes("localhost");
const sql = postgres(databaseUrl, {
  ssl: isLocal ? false : "require",
  max: 2,
});

async function main() {
  const candidates = await sql`
    SELECT id, title, published_link
    FROM production_items
    WHERE post_type = 'newsletter'
      AND newsletter_body_html IS NULL
      AND published_link LIKE 'https://www.klaviyo.com/campaign/%'
    ORDER BY published_date DESC NULLS LAST
  `;

  console.log(`Found ${candidates.length} newsletter rows to re-enrich.`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  · ${c.id} — ${c.title}`);
  }
  if (candidates.length > 5) console.log(`  · …and ${candidates.length - 5} more`);

  if (dryRun) {
    console.log("\nDry run. Re-run with --apply to enqueue enrich-item jobs.");
    return;
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 2,
  });

  let enqueued = 0;
  for (const row of candidates) {
    await quickAddJob(
      { pgPool: pool },
      "enrich-item",
      { productionItemId: row.id, force: true },
      { jobKey: `enrich-item-${row.id}`, jobKeyMode: "unsafe_dedupe" },
    );
    enqueued++;
    if (enqueued % 25 === 0) {
      console.log(`  enqueued ${enqueued}/${candidates.length}`);
    }
  }
  await pool.end();
  console.log(`\nEnqueued ${enqueued} enrich-item jobs (force=true).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
