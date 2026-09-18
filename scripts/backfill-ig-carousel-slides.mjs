/**
 * Backfill: archive carousel slides for published Instagram posts that were
 * enriched before 2026-09-18.
 *
 * Until then the IG enricher only archived `edge_sidecar_to_children` slides
 * when called with `withMedia: true` (the 10-credit variant), which the
 * hourly sweep never does — so our own published PLAYBOOK / TMZ / Slideshow
 * carousels have a poster and zero rows in `production_item_media`. The
 * sidecar is on the plain 1-credit response, so a forced re-run now archives
 * every slide for 1 credit per post.
 *
 * Targets: Published items whose published_link is an instagram.com/p/ post
 * with no media rows yet. Reels (`/reel/`) are single-media and unaffected.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-ig-carousel-slides.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-ig-carousel-slides.mjs --apply [--limit N]
 */
import postgres from "postgres";
import pg from "pg";
import { quickAddJob } from "graphile-worker";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 500;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const isLocal = databaseUrl.includes("localhost");
const sql = postgres(databaseUrl, { ssl: isLocal ? false : "require", max: 2 });

async function main() {
  const candidates = await sql`
    SELECT p.id, p.title, p.format, p.published_at
    FROM production_items p
    WHERE p.status = 'Published'
      AND p.published_link ~* 'instagram\\.com/p/'
      AND NOT EXISTS (SELECT 1 FROM production_item_media m WHERE m.production_item_id = p.id)
    ORDER BY p.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  console.log(`Found ${candidates.length} published IG posts with no archived slides.`);
  for (const c of candidates.slice(0, 8)) {
    console.log(`  · ${c.id} — [${c.format ?? "—"}] ${c.title}`);
  }
  if (candidates.length > 8) console.log(`  · …and ${candidates.length - 8} more`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to enqueue enrich-item jobs (force=true, 1 SC credit each).");
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
      { jobKey: `enrich-item-${row.id}`, jobKeyMode: "unsafe_dedupe" }
    );
    enqueued++;
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
