// Bulk local archive of YouTube videos to prod S3 + prod DB. Use this when
// Heroku's datacenter IP is bot-checked — the residential IP on your laptop
// isn't (today), so we shell out to the same yt-dlp binary the worker uses
// and write to the same prod bucket + DB.
//
// Standalone: does not import @/lib/db (which bakes the DATABASE_URL at
// module load time and caused a silent local-write bug in the first version
// of this script). Uses pg + @aws-sdk directly.
//
// Usage:
//   source .env.local.export  # exposes AWS_* + HUBANDSPOKE_S3_BUCKET
//   PROD_DB_URL=$(heroku config:get DATABASE_URL --app hubandspoke) \
//     npx tsx scripts/archive-yt-local.ts --brands=starter-story,matg --since=2025-04-23 --limit=200
//
// Flags:
//   --brands=a,b       comma-separated brand list (required)
//   --since=YYYY-MM-DD only items with published_date >= this (required)
//   --limit=N          cap candidates (default: 500)
//   --max-height=N     yt-dlp resolution cap (default: 1440)
//   --ids=uuid1,uuid2  specific IDs to re-try (overrides filter query)

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

// --- args ----------------------------------------------------------------

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : undefined;
}

const BRANDS = (arg("brands") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SINCE = arg("since");
const LIMIT = Number(arg("limit") ?? "500");
const MAX_HEIGHT = Number(arg("max-height") ?? "1440");
const ID_LIST = (arg("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (ID_LIST.length === 0 && (!BRANDS.length || !SINCE)) {
  console.error("Usage: --brands=a,b --since=YYYY-MM-DD [--limit=N] [--max-height=N] | --ids=uuid1,uuid2");
  process.exit(1);
}

const PROD_DB_URL = process.env.PROD_DB_URL;
if (!PROD_DB_URL) {
  console.error("PROD_DB_URL is required (run: PROD_DB_URL=$(heroku config:get DATABASE_URL --app hubandspoke) ...)");
  process.exit(1);
}
const BUCKET = process.env.HUBANDSPOKE_S3_BUCKET;
if (!BUCKET) {
  console.error("HUBANDSPOKE_S3_BUCKET is required");
  process.exit(1);
}
const S3_PREFIX = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads").replace(/\/+$/, "");
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const YT_DLP_PATH = resolve(process.cwd(), "node_modules/.yt-dlp-bin/yt-dlp");

// --- helpers -------------------------------------------------------------

const s3 = new S3Client({ region: AWS_REGION });

function buildKey(itemId: string, fileName: string): string {
  const safe = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "file";
  return `${S3_PREFIX}/${itemId}/${randomUUID()}-${safe}`;
}

const PLAYER_CLIENT_STRATEGIES = [
  { name: "default_minus_sdkless", clients: "default,-android_sdkless" },
  { name: "tv_embedded", clients: "tv_embedded,web_embedded,mweb" },
  { name: "android_vr_mweb", clients: "android_vr,mweb,web_safari" },
];

// Hard wall-clock cap per yt-dlp invocation. Some videos cause yt-dlp to
// spin forever (deleted videos that 200 with empty body, weird CDN edge
// cases). The original script had no timeout and one bad URL stalled the
// entire batch for 30+ min. 5 min is plenty for a 1440p hour-long video
// over residential bandwidth.
const YT_DLP_TIMEOUT_MS = 5 * 60 * 1000;

function runYtDlp(url: string, outputPath: string, clients: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    // `detached: true` puts yt-dlp + its children into a new process group
    // so we can kill the whole tree with `process.kill(-pid, …)`. Without
    // this, killing only the launcher leaves grandchildren (ffmpeg
    // fragments, the actual download worker) holding stderr open — which
    // means proc.on('close') never fires and our timeout silently
    // accomplishes nothing.
    const proc = spawn(
      YT_DLP_PATH,
      [
        "-f",
        `bv*[height<=${MAX_HEIGHT}]+ba/b[height<=${MAX_HEIGHT}]`,
        // Prefer H.264 over AV1/VP9 — Descript's URL import rejects AV1.
        "-S",
        "vcodec:h264",
        "--merge-output-format",
        "mp4",
        "--ffmpeg-location",
        ffmpegInstaller.path,
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--restrict-filenames",
        "--concurrent-fragments",
        "4",
        // Per-socket read/connect timeout. Without this yt-dlp can hang
        // indefinitely on a stalled CDN response.
        "--socket-timeout",
        "30",
        "--extractor-args",
        `youtube:player_client=${clients}`,
        "-o",
        outputPath,
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    let stderr = "";
    let killedByTimeout = false;
    const killTree = (signal: NodeJS.Signals) => {
      try {
        // Negative PID kills the whole process group on POSIX.
        if (proc.pid !== undefined) process.kill(-proc.pid, signal);
      } catch {
        /* group already gone */
      }
    };
    const killTimer = setTimeout(() => {
      killedByTimeout = true;
      killTree("SIGKILL");
    }, YT_DLP_TIMEOUT_MS);
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      rejectPromise(new Error(`spawn: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (killedByTimeout) {
        rejectPromise(new Error(`timeout after ${YT_DLP_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (code === 0) resolvePromise();
      else {
        const lastErr = stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 400);
        rejectPromise(new Error(`exited ${code}: ${lastErr}`));
      }
    });
  });
}

async function archiveOne(
  pool: pg.Pool,
  item: { id: string; youtube_id: string | null; youtube_url: string; title: string | null },
  tmpDir: string,
): Promise<{ ok: true; bytes: number } | { ok: false; err: string }> {
  const tmpPath = join(tmpDir, `${item.id}.mp4`);
  const errs: string[] = [];
  try {
    let downloaded = false;
    for (const s of PLAYER_CLIENT_STRATEGIES) {
      await unlink(tmpPath).catch(() => {});
      try {
        await runYtDlp(item.youtube_url, tmpPath, s.clients);
        downloaded = true;
        break;
      } catch (err) {
        errs.push(`[${s.name}] ${(err as Error).message}`);
      }
    }
    if (!downloaded) return { ok: false, err: errs.join(" || ").slice(0, 450) };

    const fileStat = await stat(tmpPath);
    const key = buildKey(item.id, `${item.youtube_id ?? "video"}.mp4`);
    await new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: createReadStream(tmpPath),
        ContentType: "video/mp4",
      },
    }).done();

    // Retry the success-path UPDATE up to 4× with backoff. We've already
    // spent the bandwidth on yt-dlp + S3; if the PG conn was reaped during
    // a long upload we MUST retry rather than orphan the S3 object.
    // Without this, conn-flaps cost us 15+ min per item AND leak storage.
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await pool.query(
          `UPDATE production_items
             SET media_s3_bucket = $2,
                 media_s3_key = $3,
                 media_s3_uploaded_at = NOW(),
                 media_size_bytes = $4,
                 media_content_type = 'video/mp4',
                 youtube_download_source = 'yt-dlp',
                 youtube_download_error = NULL,
                 youtube_download_attempts = youtube_download_attempts + 1
           WHERE id = $1`,
          [item.id, BUCKET, key, fileStat.size],
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
    if (lastErr) throw lastErr;

    // Auto-chain: enqueue Whisper transcription on the prod graphile_worker
    // queue using the same pool that just wrote the UPDATE. Can't import
    // maybeEnqueueWhisperTranscribe() because it pulls in @/lib/db, which
    // would bake DATABASE_URL — see the standalone-script header above.
    if (process.env.WHISPER_TRANSCRIBE_LIVE !== "false") {
      try {
        const existing = await pool.query<{ has_text: boolean }>(
          `SELECT length(full_text) > 0 AS has_text
             FROM transcripts
            WHERE production_item_id = $1
            LIMIT 1`,
          [item.id],
        );
        if (!existing.rows[0]?.has_text) {
          await pool.query(
            `SELECT graphile_worker.add_job(
               'transcribe-whisper',
               payload => $1::json,
               job_key => $2
             )`,
            [JSON.stringify({ productionItemId: item.id }), `transcribe-whisper:${item.id}`],
          );
        }
      } catch (err) {
        console.warn(`  [transcribe enqueue] ${item.id}: ${(err as Error).message}`);
      }
    }

    return { ok: true, bytes: fileStat.size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool
      .query(
        `UPDATE production_items
           SET youtube_download_error = $2,
               youtube_download_attempts = youtube_download_attempts + 1
         WHERE id = $1`,
        [item.id, msg.slice(0, 500)],
      )
      .catch(() => {});
    return { ok: false, err: msg };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

// --- main ----------------------------------------------------------------

async function main() {
  const tmpDir = join(tmpdir(), `yt-archive-${randomUUID().slice(0, 8)}`);
  await mkdir(tmpDir, { recursive: true });
  const pool = new pg.Pool({
    connectionString: PROD_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    // TCP keepalive: long video downloads (1-3 min) leave the pg conn
    // idle; without keepalive Heroku Postgres reaps it and the next query
    // gets ETIMEDOUT. The default `idleTimeoutMillis` (10s) also closes
    // idle conns aggressively, so bump that too.
    keepAlive: true,
    // Begin sending TCP keepalive probes after 30s of idle. macOS default
    // is 2h, well past Heroku Postgres's idle reap, which is what was
    // dropping connections during long S3 uploads.
    keepAliveInitialDelayMillis: 30 * 1000,
    idleTimeoutMillis: 30 * 60 * 1000,
  });
  // Pool-level error handler: pg emits 'error' on the pool when a backend
  // connection dies mid-idle (network blip, server reap). Without this
  // listener Node bubbles it up as an unhandled error and kills the
  // process — losing all in-flight progress mid-batch. Logging is enough;
  // the next query will transparently grab a new connection.
  pool.on("error", (err) => {
    console.warn(`[pool] backend conn error (will reconnect): ${err.message}`);
  });

  let items: Array<{ id: string; youtube_id: string | null; youtube_url: string; title: string | null }>;

  if (ID_LIST.length > 0) {
    const r = await pool.query(
      `SELECT id, youtube_id, youtube_url, title FROM production_items WHERE id = ANY($1::uuid[]) AND youtube_url IS NOT NULL`,
      [ID_LIST],
    );
    items = r.rows;
  } else {
    // Skip items that have already failed >= 3 times. These are almost
    // always videos deleted/privatized on YouTube — retrying just stalls
    // the batch behind the same dead URLs. Operators can re-run with
    // `--ids=…` to force a specific item.
    const r = await pool.query(
      `SELECT id, youtube_id, youtube_url, title
         FROM production_items
        WHERE status = 'Published'
          AND youtube_id IS NOT NULL
          AND media_s3_key IS NULL
          AND published_date >= $1::date
          AND brand = ANY($2::text[])
          AND COALESCE(youtube_download_attempts, 0) < 3
        ORDER BY published_date DESC NULLS LAST
        LIMIT $3`,
      [SINCE, BRANDS, LIMIT],
    );
    items = r.rows;
  }

  console.log(`Found ${items.length} candidates. Starting...`);
  const t0 = Date.now();
  let okCount = 0;
  let bytesTotal = 0;
  const failures: Array<{ id: string; title: string | null; err: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prefix = `[${i + 1}/${items.length}] ${item.id}`;
    process.stdout.write(`${prefix} ${(item.title ?? "").slice(0, 50)}... `);
    const start = Date.now();
    const res = await archiveOne(pool, item, tmpDir);
    const ms = Date.now() - start;
    if (res.ok) {
      okCount++;
      bytesTotal += res.bytes;
      console.log(`✓ ${(res.bytes / 1048576).toFixed(1)} MB ${ms}ms`);
    } else {
      failures.push({ id: item.id, title: item.title, err: res.err });
      console.log(`✗ ${ms}ms — ${res.err.slice(0, 120)}`);
    }
  }

  console.log(`\n=== done ===`);
  console.log(
    `${okCount}/${items.length} succeeded, ${(bytesTotal / 1073741824).toFixed(2)} GB total, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`,
  );
  if (failures.length) {
    console.log(`\nfailed:`);
    for (const f of failures) console.log(`  ${f.id}  "${(f.title ?? "").slice(0, 50)}" — ${f.err.slice(0, 160)}`);
  }
  await pool.end();
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
