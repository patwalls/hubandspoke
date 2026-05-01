#!/usr/bin/env node
/**
 * One-time backfill: enqueue `generate-clip-ideas` for long-form YouTube
 * pillars published in the last 90 days that have a transcript but no
 * existing clip_ideas rows.
 *
 * Background: clip-idea generation was manual-only (Generate button on the
 * pillar detail page) until 2026-05-01, when whisper-pipeline started auto-
 * fanning out to `generate-clip-ideas` after a fresh transcript saved. This
 * script is the catch-up pass for the historic videos that already have
 * transcripts saved — without it, only newly-transcribed videos would get
 * clip ideas going forward.
 *
 * Strategy: SELECT every published youtube_long original where a transcript
 * exists, no clip_ideas exist, and published_date >= NOW() - 90 days. Enqueue
 * one `generate-clip-ideas` job per pillar via graphile_worker.add_job. Worker
 * processes them at its own concurrency; this script just hands off.
 *
 * Usage:
 *   Local:        node --env-file=.env.local scripts/backfill-clip-ideas.mjs
 *   Local apply:  node --env-file=.env.local scripts/backfill-clip-ideas.mjs --apply
 *   Heroku:       heroku run --app=hubandspoke "node scripts/backfill-clip-ideas.mjs --apply"
 *
 * Flags:
 *   --apply         Actually enqueue (default: dry run)
 *   --brand=slug    Restrict to one brand (default: all brands)
 *   --days=N        Look-back window (default: 90)
 *   --limit=N       Cap the number of pillars enqueued in this run (default: unlimited)
 *
 * Idempotent — `generate-clip-ideas` skips pillars that already have any
 * clip_ideas row, so re-running after --apply is safe.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY_RUN = !APPLY;
const BRAND = args.find((a) => a.startsWith("--brand="))?.split("=")[1] ?? null;
const DAYS = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "90");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0");

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

console.log(
  `Mode: ${DRY_RUN ? "DRY RUN (use --apply to enqueue)" : "APPLY"}; brand=${BRAND ?? "all"}; days=${DAYS}; limit=${LIMIT || "unlimited"}`,
);

try {
  const candidates = await sql`
    SELECT
      pi.id            AS production_item_id,
      pi.brand         AS brand,
      pi.title         AS title,
      pi.published_date AS published_date,
      LENGTH(t.full_text) AS transcript_chars
    FROM production_items pi
    JOIN transcripts t ON t.production_item_id = pi.id
    LEFT JOIN clip_ideas ci ON ci.source_production_item_id = pi.id
    WHERE pi.post_type = 'youtube_long'
      AND pi.source_type = 'original'
      AND pi.deleted_at IS NULL
      AND pi.published_date >= (CURRENT_DATE - (${DAYS}::int * INTERVAL '1 day'))
      AND t.full_text IS NOT NULL
      AND LENGTH(t.full_text) > 0
      AND ci.id IS NULL
      ${BRAND ? sql`AND pi.brand = ${BRAND}` : sql``}
    GROUP BY pi.id, pi.brand, pi.title, pi.published_date, t.full_text
    ORDER BY pi.published_date DESC
    ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}
  `;

  console.log(`Found ${candidates.length} pillar(s) eligible for clip-idea backfill`);

  for (const row of candidates) {
    console.log(
      `  ${DRY_RUN ? "WOULD ENQUEUE" : "ENQUEUE"}  ${row.production_item_id}  brand=${row.brand}  pub=${row.published_date}  "${(row.title ?? "").slice(0, 60)}"  transcript=${row.transcript_chars}c`,
    );
    if (!DRY_RUN) {
      await sql`
        SELECT graphile_worker.add_job(
          'generate-clip-ideas',
          payload   => ${JSON.stringify({ productionItemId: row.production_item_id })}::json,
          job_key   => ${`generate-clip-ideas-${row.production_item_id}`},
          job_key_mode => 'unsafe_dedupe'
        )
      `;
    }
  }

  console.log("");
  console.log(`Summary: candidates=${candidates.length}`);
  if (DRY_RUN) {
    console.log("Re-run with --apply to enqueue.");
  } else {
    console.log(
      `Enqueued ${candidates.length} job(s). Watch progress: heroku logs --app hubandspoke --dyno worker --tail | grep generate-clip-ideas`,
    );
  }
} finally {
  await sql.end();
}
