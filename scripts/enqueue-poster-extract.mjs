#!/usr/bin/env node
/**
 * Fans out `extract-poster` jobs for every Published short-form item that
 * has a `mediaS3Key` but no `posterS3Key`. ffmpeg pulls frame 0 out of the
 * archived .mp4 and uploads it as a JPEG poster — closing the silent gap
 * where IG's Scrape Creators response sometimes omits `display_url`.
 *
 * After this drains, the existing `vision-extract-sweep` (cron `:55`) picks
 * the items up and OCRs the on-video burn-in overlay into `hook` + `overlay`.
 *
 * Usage:
 *   node scripts/enqueue-poster-extract.mjs              # dry-run
 *   node scripts/enqueue-poster-extract.mjs --apply
 *   heroku run --app=hubandspoke "node scripts/enqueue-poster-extract.mjs --apply"
 */
import postgres from "postgres";
import { quickAddJob } from "graphile-worker";
import pg from "pg";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "..", ".env.local") });

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

const POST_TYPES = ["instagram_reel", "instagram_post", "tiktok", "youtube_shorts"];

async function main() {
  console.log(`[enqueue-poster-extract] mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}`);

  const candidates = await sql`
    SELECT id, post_type
    FROM production_items
    WHERE status = 'Published'
      AND poster_s3_key IS NULL
      AND media_s3_key IS NOT NULL
      AND post_type = ANY(${POST_TYPES})
    ORDER BY views DESC NULLS LAST
  `;

  const byType = {};
  for (const row of candidates) {
    byType[row.post_type] = (byType[row.post_type] || 0) + 1;
  }
  console.log(`Total candidates: ${candidates.length}`);
  for (const [type, n] of Object.entries(byType).sort()) {
    console.log(`  ${type.padEnd(18)} ${n}`);
  }

  if (!APPLY) {
    console.log("(dry-run — re-run with --apply to commit)");
    await sql.end();
    return;
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === "off"
        ? false
        : { rejectUnauthorized: false },
  });

  let enqueued = 0;
  for (const row of candidates) {
    await quickAddJob(
      { pgPool: pool },
      "extract-poster",
      { productionItemId: row.id },
      { jobKey: `extract-poster-${row.id}`, jobKeyMode: "unsafe_dedupe" },
    );
    enqueued++;
  }

  await pool.end();
  await sql.end();
  console.log(`Enqueued ${enqueued} jobs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
