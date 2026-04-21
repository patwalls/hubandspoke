#!/usr/bin/env node
/**
 * One-time backfill: fetch each tweet's `full_text` from Scrape Creators and
 * write it into production_items.content_body for rows where we have a tweet
 * URL but no body yet.
 *
 * Costs 1 SC credit per row (≈$0.002 at current pricing).
 *
 * Usage:
 *   node scripts/backfill-tweet-bodies.mjs                    # dry-run
 *   node scripts/backfill-tweet-bodies.mjs --apply            # persist
 *   node scripts/backfill-tweet-bodies.mjs --apply --limit=5  # bounded
 *
 *   heroku run --app=hubandspoke "node scripts/backfill-tweet-bodies.mjs --apply"
 *
 * Idempotent — skips rows that already have content_body set.
 */
import postgres from "postgres";
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
if (!process.env.SCRAPE_CREATORS_API_KEY) {
  console.error("ERROR: SCRAPE_CREATORS_API_KEY missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

const SC_BASE = "https://api.scrapecreators.com";
const SC_HEADERS = { "x-api-key": process.env.SCRAPE_CREATORS_API_KEY };

async function fetchTweet(tweetUrl) {
  const url = `${SC_BASE}/v1/twitter/tweet?url=${encodeURIComponent(tweetUrl)}`;
  const res = await fetch(url, { headers: SC_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`SC ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.tweet || data.data || data;
}

async function main() {
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Backfilling content_body for tweets${LIMIT ? ` (limit=${LIMIT})` : ""}\n`
  );

  const rows = await sql`
    SELECT id, published_link, title
    FROM production_items
    WHERE content_body IS NULL
      AND (
        published_link ILIKE '%x.com/%/status/%'
        OR published_link ILIKE '%twitter.com/%/status/%'
      )
    ORDER BY published_date DESC NULLS LAST
    ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}
  `;

  console.log(`Found ${rows.length} tweet rows missing content_body\n`);

  let filled = 0;
  let missing = 0;
  let errors = 0;

  for (const r of rows) {
    try {
      if (DRY_RUN) {
        console.log(`  [dry] would fetch ${r.published_link}`);
        continue;
      }
      const tweet = await fetchTweet(r.published_link);
      const body = tweet?.legacy?.full_text ?? "";
      if (!body) {
        console.log(`  [miss] ${r.published_link} — no full_text returned`);
        missing++;
        continue;
      }
      await sql`
        UPDATE production_items
        SET content_body = ${body},
            content_body_fetched_at = now(),
            content_body_source = 'scrape_creators',
            updated_at = now()
        WHERE id = ${r.id}
      `;
      filled++;
      if (filled % 10 === 0) console.log(`  [${filled}] ${r.published_link}`);
    } catch (err) {
      errors++;
      console.error(`  [err] ${r.published_link}:`, err.message);
    }
  }

  console.log(
    `\n${DRY_RUN ? "[DRY RUN] " : ""}Done. filled=${filled} missing=${missing} errors=${errors} total=${rows.length}`
  );
  if (DRY_RUN && rows.length > 0) {
    console.log(`\nRe-run with --apply to persist. Estimated cost: ${rows.length} SC credits.`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  sql.end();
  process.exit(1);
});
