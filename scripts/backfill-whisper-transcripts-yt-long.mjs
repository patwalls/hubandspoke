/**
 * One-shot backfill: enqueue `transcribe-whisper` for every YouTube long-form
 * production_item that has archived MP4 media in S3 (`media_s3_key` set) but
 * no `transcripts` row with non-empty `full_text`.
 *
 * Scope: published_date within the last 1 year. Date window per operator
 * decision — earlier sweeps left the longer tail at ~820 items going back
 * 2y, but transcripts older than ~12 months rarely drive new repurpose work
 * and the OpenAI Whisper spend isn't worth it for them.
 *
 * Runs safely on Heroku (no yt-dlp involved). Each enqueued task reads the
 * archived MP4 from S3, extracts audio chunks, calls OpenAI Whisper, and
 * upserts a `transcripts` row. transcribe-whisper itself is idempotent on
 * `transcripts.full_text` so a re-run is a no-op for already-transcribed
 * rows.
 *
 * Usage:
 *   heroku run --app=hubandspoke -- node scripts/backfill-whisper-transcripts-yt-long.mjs            # dry-run
 *   heroku run --app=hubandspoke -- node scripts/backfill-whisper-transcripts-yt-long.mjs --apply    # commit
 *
 * Flags:
 *   --apply             enqueue (default: dry-run)
 *   --since=YYYY-MM-DD  override the published_date floor (default: now - 1y)
 *   --limit=N           cap candidates (default: 2000 — more than the known set)
 */
import postgres from "postgres";
import pg from "pg";
import { quickAddJob } from "graphile-worker";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

function arg(name) {
  const flag = `--${name}=`;
  const hit = args.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : undefined;
}

const since = arg("since") ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const limit = Number(arg("limit") ?? "2000");

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
    SELECT id, title, published_date, media_s3_key
    FROM production_items p
    WHERE p.post_type = 'youtube_long'
      AND p.status = 'Published'
      AND p.media_s3_key IS NOT NULL
      AND p.published_date >= ${since}::date
      AND NOT EXISTS (
        SELECT 1 FROM transcripts t
        WHERE t.production_item_id = p.id
          AND t.full_text IS NOT NULL
          AND LENGTH(t.full_text) > 0
      )
    ORDER BY p.published_date DESC NULLS LAST
    LIMIT ${limit}
  `;

  console.log(
    `Found ${candidates.length} youtube_long items with media but no transcript, published >= ${since}.`,
  );
  for (const c of candidates.slice(0, 5)) {
    console.log(`  · ${c.id} (${c.published_date}) ${c.title}`);
  }
  if (candidates.length > 5) {
    console.log(`  · …and ${candidates.length - 5} more`);
  }

  if (dryRun) {
    console.log("\nDry run. Re-run with --apply to enqueue transcribe-whisper jobs.");
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
      "transcribe-whisper",
      { productionItemId: row.id },
      {
        // Same key the auto-enqueue path uses (see archive-yt-local.ts and
        // transcribe-after-upload.ts) so re-runs of either side don't
        // create duplicate jobs.
        jobKey: `transcribe-whisper:${row.id}`,
        jobKeyMode: "unsafe_dedupe",
      },
    );
    enqueued++;
    if (enqueued % 50 === 0) {
      console.log(`  enqueued ${enqueued}/${candidates.length}`);
    }
  }
  await pool.end();
  console.log(`\nEnqueued ${enqueued} transcribe-whisper jobs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
