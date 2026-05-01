#!/usr/bin/env node
/**
 * One-shot: refresh hook (and other enrichment fields) for every Published
 * long-form YouTube item by re-running the YT enricher with `force=true`.
 *
 * Why: the YT enricher previously discarded `data.title` from the SC
 * response, so older items have `hook` set to the Notion working title
 * (e.g. "Evan Yadegari: Locked - Partner with influencers to scale") rather
 * than the live published YouTube title that viewers actually click on.
 * The 2026-05-01 change to `src/lib/services/enrichment/youtube.ts` writes
 * the live title to `hook` going forward; this script back-applies it to
 * the existing inventory.
 *
 * Skips clip_idea / manual hook sources so a human-curated hook is never
 * touched. Costs ~1 SC credit per item.
 *
 * Usage:
 *   node scripts/refresh-yt-hooks.mjs              # dry-run
 *   node scripts/refresh-yt-hooks.mjs --apply
 *   heroku run --app=hubandspoke "node scripts/refresh-yt-hooks.mjs --apply"
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
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : null;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

async function main() {
  console.log(`[refresh-yt-hooks] mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  const candidates = await sql`
    SELECT id, LEFT(hook, 60) AS current_hook, hook_source
    FROM production_items
    WHERE post_type = 'youtube_long'
      AND status = 'Published'
      AND published_link IS NOT NULL
      AND COALESCE(hook_source, '') NOT IN ('clip_idea', 'manual')
    ORDER BY views DESC NULLS LAST
    ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}
  `;

  console.log(`Total candidates: ${candidates.length}`);

  if (!APPLY) {
    console.log("(dry-run — re-run with --apply to commit)");
    for (const row of candidates.slice(0, 5)) {
      console.log(`  - ${row.id}  source=${row.hook_source ?? "null"}  hook=${row.current_hook ?? "(null)"}`);
    }
    if (candidates.length > 5) console.log(`  ... and ${candidates.length - 5} more`);
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
      "enrich-item",
      { productionItemId: row.id, force: true },
      { jobKey: `enrich-item-${row.id}`, jobKeyMode: "unsafe_dedupe" },
    );
    enqueued++;
  }

  await pool.end();
  await sql.end();
  console.log(`Enqueued ${enqueued} enrich-item jobs (force=true).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
