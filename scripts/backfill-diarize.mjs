/**
 * Backfill: speaker detection for transcripts that predate it.
 *
 * NEW long-form transcripts get speakers automatically (transcribe-whisper →
 * diarize-transcript). This script is for the back catalogue — and it is
 * deliberately NOT automatic, because it costs real money and time:
 *
 *   ~ $1.35 and ~28 min of API time per HOUR of audio   (measured 2026-09-17)
 *   whole corpus at that date: ~680 h  →  ~$900, ~13 days on one queue
 *
 * It also holds ONE OF THE WORKER'S TWO job slots for the whole run (each call
 * is a ~5-minute network wait), so everything else on the worker runs at half
 * throughput meanwhile. Run it off-hours, in small --limit batches.
 *
 * So target it. Jobs go on the `diarize-backfill` queue (serialized, separate
 * from the live `diarize` queue) so a backfill never delays a fresh video.
 *
 *   # dry run (default): what would be queued, with a cost estimate
 *   heroku run --app hubandspoke -- node scripts/backfill-diarize.mjs --brand starter-story --since 2026-07-01
 *   # queue them
 *   heroku run --app hubandspoke -- node scripts/backfill-diarize.mjs --brand starter-story --since 2026-07-01 --limit 50 --apply
 *
 * Flags: --brand <slug>  --post-type <type, default youtube_long>  --all-post-types
 *        --since <YYYY-MM-DD, by published date>  --min-minutes <n, default 2>
 *        --limit <n, default 25>  --apply
 */
import postgres from "postgres";
import pg from "pg";
import { quickAddJob } from "graphile-worker";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const apply = flag("apply");
const brand = opt("brand");
const postType = flag("all-post-types") ? null : opt("post-type", "youtube_long");
const since = opt("since");
const minMinutes = Number(opt("min-minutes", "2"));
const limit = Number(opt("limit", "25"));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const isLocal = databaseUrl.includes("localhost");
const sql = postgres(databaseUrl, { ssl: isLocal ? false : "require", max: 2 });

const USD_PER_HOUR = 1.35;
const API_MIN_PER_AUDIO_HOUR = 28;

async function main() {
  const rows = await sql`
    SELECT t.production_item_id AS id, pi.title, pi.brand, pi.post_type,
           t.duration_sec::float AS duration_sec
    FROM transcripts t
    JOIN production_items pi ON pi.id = t.production_item_id
    WHERE t.source = 'whisper'
      AND t.diarized_at IS NULL
      AND (t.diarization IS NULL OR t.diarization->>'status' <> 'running')
      AND t.audio_s3_key IS NOT NULL
      AND t.words IS NOT NULL
      AND t.duration_sec::float >= ${minMinutes * 60}
      AND pi.deleted_at IS NULL
      ${brand ? sql`AND pi.brand = ${brand}` : sql``}
      ${postType ? sql`AND pi.post_type = ${postType}` : sql``}
      ${since ? sql`AND pi.published_date >= ${since}` : sql``}
    ORDER BY pi.published_date DESC NULLS LAST
    LIMIT ${limit}
  `;

  const hours = rows.reduce((n, r) => n + r.duration_sec, 0) / 3600;
  console.log(
    `${rows.length} transcript(s) match (limit ${limit})  ·  ${hours.toFixed(1)} h of audio  ·  ≈ $${(hours * USD_PER_HOUR).toFixed(2)}  ·  ≈ ${Math.round(hours * API_MIN_PER_AUDIO_HOUR)} min of queue time`,
  );
  for (const r of rows.slice(0, 10)) {
    console.log(`  · ${r.id}  ${(r.duration_sec / 60).toFixed(0).padStart(3)}m  [${r.brand}/${r.post_type}]  ${(r.title ?? "").slice(0, 70)}`);
  }
  if (rows.length > 10) console.log(`  · …and ${rows.length - 10} more`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to queue diarize-transcript jobs.");
    return;
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 2,
  });
  try {
    for (const r of rows) {
      await quickAddJob(
        { pgPool: pool },
        "diarize-transcript",
        { productionItemId: r.id, queue: "diarize-backfill" },
        {
          jobKey: `diarize:${r.id}`,
          jobKeyMode: "replace",
          queueName: "diarize-backfill",
          maxAttempts: 5,
        },
      );
    }
    console.log(`\nQueued ${rows.length} job(s) on the diarize-backfill queue.`);
  } finally {
    await pool.end();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
