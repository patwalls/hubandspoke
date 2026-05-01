#!/usr/bin/env node
/**
 * Fans out `vision-extract` jobs for every published Repackage-Section-w/-Hook
 * IG item that has an archived poster. Vision OCRs the bold burn-in text
 * painted onto the cover and writes it to `hook` + `overlay` with
 * `hook_source='vision'`.
 *
 * One-shot complement to `revert-repackage-overlay-backfill.mjs`. After this
 * runs, the worker dyno will process the queue within ~1ms each via
 * LISTEN/NOTIFY; full backfill of ~30 items takes a couple of minutes.
 *
 * Items without a posterS3Key are left alone — enrichment hasn't archived
 * the cover yet. Once enrichment runs (hourly) and the new
 * `vision-extract-sweep` cron picks them up, they'll get OCR'd
 * automatically. No second invocation needed.
 *
 * Usage:
 *   node scripts/enqueue-vision-for-repackage.mjs              # dry-run
 *   node scripts/enqueue-vision-for-repackage.mjs --apply
 *   heroku run --app=hubandspoke "node scripts/enqueue-vision-for-repackage.mjs --apply"
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

async function main() {
  console.log(`[enqueue-vision-for-repackage] mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}`);

  const candidates = await sql`
    SELECT id, vision_extracted_at IS NOT NULL AS vision_done, hook
    FROM production_items
    WHERE LOWER(format) IN (
            'reel: repackage section w/ hook',
            'repackage section with hook'
          )
      AND post_type IN ('instagram_reel', 'instagram_post')
      AND source_type IN ('original', 'repost')
      AND status = 'Published'
      AND poster_s3_key IS NOT NULL
      AND COALESCE(hook_source, '') NOT IN ('manual', 'clip_idea')
    ORDER BY views DESC NULLS LAST
  `;

  const fresh = candidates.filter((c) => !c.vision_done);
  const alreadyDone = candidates.filter((c) => c.vision_done);
  const needsClear = candidates.filter((c) => c.vision_done && !c.hook);

  console.log(`Total IG Repackage with poster : ${candidates.length}`);
  console.log(`  vision not yet run           : ${fresh.length}`);
  console.log(`  vision already ran           : ${alreadyDone.length}`);
  console.log(`    of those, no hook stored   : ${needsClear.length}`);

  // Clear vision_extracted_at on rows where vision ran but didn't yield a
  // hook — most of these are pre-overlay-column rows where vision saw an
  // overlay, picked it, but our wrong revert wiped the value. Re-running
  // vision on them is cheap and produces the right answer.
  if (APPLY && needsClear.length > 0) {
    const ids = needsClear.map((r) => r.id);
    const result = await sql`
      UPDATE production_items
      SET vision_extracted_at = NULL,
          updated_at = now()
      WHERE id = ANY(${ids})
    `;
    console.log(`Cleared vision_extracted_at on ${result.count} rows for re-OCR`);
  }

  const toEnqueue = APPLY ? [...fresh, ...needsClear] : fresh;
  console.log(`Will enqueue                   : ${toEnqueue.length} vision-extract jobs`);

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
  for (const row of toEnqueue) {
    await quickAddJob(
      { pgPool: pool },
      "vision-extract",
      { productionItemId: row.id },
      { jobKey: `vision-extract-${row.id}`, jobKeyMode: "unsafe_dedupe" }
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
