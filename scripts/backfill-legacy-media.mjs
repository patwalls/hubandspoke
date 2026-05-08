#!/usr/bin/env node
/**
 * Backfill: synthesize a `production_item_media` row at index 0 for every
 * `production_items` row that has a legacy `media_s3_key` set but zero
 * carousel rows.
 *
 * The carousel table (`production_item_media`) is the new source of truth for
 * media. Many production_items rows were enriched before that table existed
 * (or under enrichment paths that wrote ONLY to the legacy single-media
 * columns: `media_s3_key`, `media_s3_bucket`, `media_content_type`,
 * `poster_s3_key`, `media_size_bytes`). The simulator reads slides from
 * carousel rows preferentially; without one, slides built from the legacy
 * fallback path lack a `mediaId`, which breaks the X-button delete affordance
 * in the dropzone.
 *
 * After this runs, every item with media has at least one carousel row →
 * `slide.mediaId` is always set → delete UI works everywhere.
 *
 * Idempotent — uses `NOT EXISTS` to skip items that already have rows.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-legacy-media.mjs
 *   node --env-file=.env.local scripts/backfill-legacy-media.mjs --dry-run
 *
 *   heroku run --app=hubandspoke node scripts/backfill-legacy-media.mjs
 */
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
  };
}

async function main() {
  const { dryRun } = parseArgs();

  const sql = postgres(process.env.DATABASE_URL, {
    ssl: process.env.DATABASE_SSL === "off" ? false : "require",
  });

  // First, count what we'd insert. Same predicate as the INSERT below.
  const [{ count: pendingCount }] = await sql`
    SELECT COUNT(*)::int AS count
    FROM production_items pi
    WHERE pi.media_s3_key IS NOT NULL
      AND pi.media_s3_bucket IS NOT NULL
      AND pi.media_content_type IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM production_item_media pim
        WHERE pim.production_item_id = pi.id
      )
  `;

  if (pendingCount === 0) {
    console.log("✅ Nothing to backfill — every item with media already has a carousel row.");
    await sql.end();
    return;
  }

  if (dryRun) {
    console.log(`🔍 [dry-run] Would insert ${pendingCount} production_item_media row(s).`);
    // Show a small sample to make the dry-run useful.
    const sample = await sql`
      SELECT pi.id, pi.title, pi.post_type, pi.media_content_type, pi.media_s3_key
      FROM production_items pi
      WHERE pi.media_s3_key IS NOT NULL
        AND pi.media_s3_bucket IS NOT NULL
        AND pi.media_content_type IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM production_item_media pim
          WHERE pim.production_item_id = pi.id
        )
      ORDER BY pi.updated_at DESC
      LIMIT 5
    `;
    for (const row of sample) {
      console.log(
        `  - ${row.id} (${row.post_type}, ${row.media_content_type}): "${row.title?.slice(0, 60) ?? "(no title)"}"`,
      );
    }
    if (pendingCount > sample.length) {
      console.log(`  ... and ${pendingCount - sample.length} more.`);
    }
    await sql.end();
    return;
  }

  // Real run. One INSERT, transactional by virtue of the single statement.
  // `kind` is derived from `media_content_type`: anything starting `video/`
  // → 'video', else 'image'. Schema requires kind / s3_bucket / s3_key /
  // content_type non-null — the WHERE clause guarantees the latter three.
  const inserted = await sql`
    INSERT INTO production_item_media
      (production_item_id, index, kind, s3_bucket, s3_key, content_type,
       size_bytes, poster_s3_key, source_url, uploaded_at)
    SELECT
      pi.id,
      0,
      CASE WHEN pi.media_content_type LIKE 'video/%' THEN 'video' ELSE 'image' END,
      pi.media_s3_bucket,
      pi.media_s3_key,
      pi.media_content_type,
      pi.media_size_bytes,
      pi.poster_s3_key,
      NULL,
      COALESCE(pi.media_s3_uploaded_at, NOW())
    FROM production_items pi
    WHERE pi.media_s3_key IS NOT NULL
      AND pi.media_s3_bucket IS NOT NULL
      AND pi.media_content_type IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM production_item_media pim
        WHERE pim.production_item_id = pi.id
      )
    RETURNING id
  `;

  console.log(`✅ Inserted ${inserted.length} production_item_media row(s).`);

  await sql.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
