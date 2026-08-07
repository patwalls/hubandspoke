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
//   --since=YYYY-MM-DD only items with published_date >= this (required unless --since-days)
//   --since-days=N     equivalent to --since=<N days ago>; useful for cron wrappers
//   --limit=N          cap candidates (default: 500)
//   --post-types=a,b   restrict to specific post types (e.g. `youtube_long`).
//                      Default: no filter (any post type with a youtube_id).
//                      Use `youtube_long` when you want long-form archives only
//                      and don't want to spend the bandwidth on Shorts.
//   --whisper-brands=a,b  restrict the auto-enqueue of `transcribe-whisper` to
//                      these brands. Default: same as `--brands` (auto-enqueue
//                      for every downloaded item). Set to a subset when you
//                      want media archived for every brand but transcripts
//                      only for some (Whisper has real OpenAI cost per minute).
//   --max-height=N     yt-dlp resolution cap (default: 1080 — Twitter caps at 1920×1200)
//   --ids=uuid1,uuid2  specific IDs to re-try (overrides filter query)
//   --sleep-min=N      min seconds yt-dlp sleeps between downloads (default: 0 — off)
//   --sleep-max=N      max seconds yt-dlp sleeps between downloads (default: 0 — off)
//
// Output is always Twitter-compatible MP4: H.264 video + AAC LC audio +
// faststart. YouTube's high-quality audio is Opus-in-WebM, which Twitter
// rejects ("Incompatible audio codecs"). We force AAC two ways: (1) the
// format selector prefers m4a audio (always AAC on YouTube), (2) the
// Merger postprocessor re-encodes audio to AAC as a safety net for the
// fallback paths.

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
const SINCE_ARG = arg("since");
const SINCE_DAYS = arg("since-days");
const LIMIT = Number(arg("limit") ?? "500");
const POST_TYPES = (arg("post-types") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const WHISPER_BRANDS_ARG = arg("whisper-brands");
const WHISPER_BRANDS = WHISPER_BRANDS_ARG !== undefined
  ? WHISPER_BRANDS_ARG.split(",").map((s) => s.trim()).filter(Boolean)
  : null; // null = no filter (every brand auto-enqueues, legacy behavior)
const MAX_HEIGHT = Number(arg("max-height") ?? "1080");
const ID_LIST = (arg("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// Polite-mode throttling for cron contexts (home-machine hourly job). Default
// 0 keeps manual ad-hoc runs fast. yt-dlp randomizes between min and max
// between each video — a few seconds of jitter dramatically reduces the
// "you're a bot" signal without meaningfully slowing a 20-video batch.
const SLEEP_MIN = Number(arg("sleep-min") ?? "0");
const SLEEP_MAX = Number(arg("sleep-max") ?? "0");
// `--cookies-from-browser=chrome` (or firefox/safari/...) defeats YouTube's
// "Sign in to confirm you're not a bot" gate on aged accounts and trending
// videos. Default to chrome since that's where Pat is signed in. Pass
// `--cookies-from-browser=none` to disable.
const COOKIES_FROM_BROWSER = (arg("cookies-from-browser") ?? "chrome").trim();
// `--cookies=/path/to/cookies.txt` uses a static Netscape cookie file instead
// of reading a live browser profile. This is what the headless launchd cron
// uses: launchd has no GUI/keychain access and Chrome locks its cookie DB, so
// browser extraction hangs there — a pre-exported file sidesteps both. yt-dlp
// also rewrites this file after each run, keeping it reasonably fresh. When
// set, it takes precedence over --cookies-from-browser.
const COOKIES_FILE = arg("cookies");
// `--count-only` resolves the candidate set, prints `CANDIDATES=<n>`, and exits
// without downloading anything. The launchd wrapper calls this first so it only
// evicts the ollama judge model when there is actually work to do — otherwise a
// quiet day still cost 24 evictions, i.e. ~450 GB/day of pointless SSD reads
// reloading an 18.8 GB model plus 24 needless judge stalls.
// See home-machine/yt-archive/wrapper.sh.
const COUNT_ONLY = process.argv.includes("--count-only");

const SINCE = SINCE_ARG ?? (SINCE_DAYS ? computeSince(Number(SINCE_DAYS)) : undefined);

function computeSince(days: number): string {
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`--since-days must be a positive number (got: ${days})`);
    process.exit(1);
  }
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

if (ID_LIST.length === 0 && (!BRANDS.length || !SINCE)) {
  console.error(
    "Usage: --brands=a,b (--since=YYYY-MM-DD | --since-days=N) [--limit=N] [--post-types=a,b] [--max-height=N] [--sleep-min=N --sleep-max=N] | --ids=uuid1,uuid2",
  );
  process.exit(1);
}

const PROD_DB_URL = process.env.PROD_DB_URL;
if (!PROD_DB_URL) {
  console.error("PROD_DB_URL is required (run: PROD_DB_URL=$(heroku config:get DATABASE_URL --app hubandspoke) ...)");
  process.exit(1);
}
const BUCKET = process.env.HUBANDSPOKE_S3_BUCKET;
// --count-only never uploads, so it needs PROD_DB_URL and nothing else. Keeping
// the S3 requirement here would make the probe fail closed on an unrelated
// misconfiguration, and the wrapper would then archive nothing while reporting
// "inconclusive" forever.
if (!BUCKET && !COUNT_ONLY) {
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
    const ytDlpArgs = [
      // Format selector prefers m4a audio — on YouTube m4a is always AAC,
      // so this avoids the Opus-in-MP4 case Twitter rejects. Falls back to
      // best-audio-merge or single-file if m4a isn't available.
      "-f",
      `bv*[height<=${MAX_HEIGHT}]+ba[ext=m4a]/bv*[height<=${MAX_HEIGHT}]+ba/b[height<=${MAX_HEIGHT}]`,
      // Prefer H.264 over AV1/VP9 — Descript's URL import rejects AV1.
      // Don't include `acodec:aac` here — it makes yt-dlp prefer YouTube's
      // 360p muxed H.264+AAC stream over the 1080p H.264 split video,
      // because muxed satisfies both sort keys. Audio AAC is enforced by
      // the `[ext=m4a]` filter in the format selector + the Merger
      // postprocessor below.
      "-S",
      "vcodec:h264",
      "--merge-output-format",
      "mp4",
      // Belt-and-suspenders for Twitter compat: when the merger runs, copy
      // video and re-encode audio to AAC LC + faststart. If format selector
      // already picked m4a, ffmpeg's `-c:a aac` re-encodes losslessly-ish
      // (the file is already AAC; cost is small CPU). If it picked Opus,
      // this is what saves the upload.
      "--postprocessor-args",
      "Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart",
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
    ];
    if (COOKIES_FILE) {
      ytDlpArgs.push("--cookies", COOKIES_FILE);
    } else if (COOKIES_FROM_BROWSER && COOKIES_FROM_BROWSER !== "none") {
      ytDlpArgs.push("--cookies-from-browser", COOKIES_FROM_BROWSER);
    }
    if (SLEEP_MIN > 0) {
      ytDlpArgs.push("--sleep-interval", String(SLEEP_MIN));
      if (SLEEP_MAX > 0 && SLEEP_MAX >= SLEEP_MIN) {
        ytDlpArgs.push("--max-sleep-interval", String(SLEEP_MAX));
      }
    }
    ytDlpArgs.push(url);
    const proc = spawn(YT_DLP_PATH, ytDlpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
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
  item: { id: string; youtube_id: string | null; youtube_url: string; title: string | null; brand: string | null },
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
    // THROW, don't return. This is the "every player-client strategy failed"
    // path, and it must land in the catch below so the item gets
    // `youtube_download_attempts + 1` and its error recorded — exactly like
    // every other failure. Returning early here skipped both, which broke two
    // things on 2026-07-30:
    //   1. `yt-archive-watch` treats attempts=0 as "the cron never saw this
    //      item" (machine off / wrapper broken) and emailed Pat + Sam that the
    //      archiver had stopped. It hadn't — it was running hourly and failing
    //      right here, so the alert named the wrong cause.
    //   2. The candidate query filters on `attempts < 3`, so these items never
    //      aged out of the pool and were re-downloaded every single hour.
    if (!downloaded) throw new Error(errs.join(" || ").slice(0, 450));

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
    //
    // `--whisper-brands` lets the operator archive media for every brand
    // (cheap, just S3 storage) but only spend OpenAI Whisper minutes on a
    // subset. When the flag is unset, every brand auto-enqueues (legacy).
    const whisperBrandAllowed =
      WHISPER_BRANDS === null
        ? true
        : item.brand !== null && WHISPER_BRANDS.includes(item.brand);
    if (process.env.WHISPER_TRANSCRIBE_LIVE !== "false" && whisperBrandAllowed) {
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

  let items: Array<{ id: string; youtube_id: string | null; youtube_url: string; title: string | null; brand: string | null }>;

  if (ID_LIST.length > 0) {
    const r = await pool.query(
      `SELECT id, youtube_id, youtube_url, title, brand FROM production_items WHERE id = ANY($1::uuid[]) AND youtube_url IS NOT NULL`,
      [ID_LIST],
    );
    items = r.rows;
  } else {
    // Skip items that have already failed >= 3 times. These are almost
    // always videos deleted/privatized on YouTube — retrying just stalls
    // the batch behind the same dead URLs. Operators can re-run with
    // `--ids=…` to force a specific item.
    // `--post-types` is optional. When unset we keep the legacy behavior
    // (any post type with a youtube_id). When set we filter to the named
    // types so a backfill targeting just long-form doesn't burn bandwidth
    // on Shorts.
    const usePostTypeFilter = POST_TYPES.length > 0;
    const r = await pool.query(
      `SELECT id, youtube_id, youtube_url, title, brand
         FROM production_items
        WHERE status = 'Published'
          AND youtube_id IS NOT NULL
          AND media_s3_key IS NULL
          AND published_date >= $1::date
          AND brand = ANY($2::text[])
          AND COALESCE(youtube_download_attempts, 0) < 3
          ${usePostTypeFilter ? `AND post_type = ANY($4::text[])` : ``}
        ORDER BY published_date DESC NULLS LAST
        LIMIT $3`,
      usePostTypeFilter ? [SINCE, BRANDS, LIMIT, POST_TYPES] : [SINCE, BRANDS, LIMIT],
    );
    items = r.rows;
  }

  if (COUNT_ONLY) {
    // Machine-readable and exact-matched by the wrapper (`^CANDIDATES=`).
    // Keep the prefix stable.
    console.log(`CANDIDATES=${items.length}`);
    await pool.end();
    process.exit(0);
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
