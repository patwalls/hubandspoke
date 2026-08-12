/**
 * One-shot YouTube download + S3 upload for a single production item.
 * Mirrors the logic of src/jobs/tasks/youtube-download.ts.
 *
 * Usage:
 *   node --env-file=.env.local scripts/run-youtube-download.mjs <productionItemId>
 */
import { spawn } from "child_process";
import { createReadStream } from "fs";
import { stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import postgres from "postgres";

const ITEM_ID = process.argv[2];
if (!ITEM_ID) {
  console.error("Usage: node scripts/run-youtube-download.mjs <productionItemId>");
  process.exit(1);
}

const YT_DLP_PATH = resolve(process.cwd(), "node_modules/.yt-dlp-bin/yt-dlp");

const PLAYER_CLIENT_STRATEGIES = [
  { name: "default_minus_sdkless", clients: "default,-android_sdkless" },
  { name: "tv_embedded", clients: "tv_embedded,web_embedded,mweb" },
  { name: "android_vr_mweb", clients: "android_vr,mweb,web_safari" },
];

function s3Client() {
  return new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

function bucketName() {
  const b = process.env.HUBANDSPOKE_S3_BUCKET;
  if (!b) throw new Error("HUBANDSPOKE_S3_BUCKET not set");
  return b;
}

function buildKey(itemId, fileName) {
  const prefix = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads").replace(/\/+$/, "");
  const safe = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "file";
  return `${prefix}/${itemId}/${randomUUID()}-${safe}`;
}

function runYtDlp({ url, outputPath, cookiesFromBrowser, playerClients }) {
  return new Promise((resolve, reject) => {
    const ytArgs = [
      "-f", "bv*[height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]",
      "-S", "vcodec:h264",
      "--merge-output-format", "mp4",
      "--postprocessor-args", "Merger:-c:v copy -c:a aac -b:a 192k -movflags +faststart",
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--restrict-filenames",
      "--concurrent-fragments", "4",
      "--extractor-args", `youtube:player_client=${playerClients}`,
      "-o", outputPath,
    ];
    if (cookiesFromBrowser) ytArgs.push("--cookies-from-browser", cookiesFromBrowser);
    ytArgs.push(url);

    console.log(`  yt-dlp ${ytArgs.slice(-10).join(" ")}`);
    const proc = spawn(YT_DLP_PATH, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stdout.on("data", (b) => process.stdout.write(b));
    proc.stderr.on("data", (b) => { stderr += b.toString(); process.stderr.write(b); });

    proc.on("error", (err) => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const lastErr = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
        reject(new Error(`yt-dlp exited ${code}${lastErr ? `: ${lastErr}` : ""}`));
      }
    });
  });
}

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });

async function enqueueWhisper(productionItemId) {
  if (process.env.WHISPER_TRANSCRIBE_LIVE === "false") {
    console.log("Whisper transcription disabled (WHISPER_TRANSCRIBE_LIVE=false), skipping.");
    return;
  }
  // Insert directly into graphile_worker.jobs — same as what enqueue() does.
  await sql`
    SELECT graphile_worker.add_job(
      'transcribe-whisper',
      ${{ productionItemId }}::jsonb,
      job_key => ${"transcribe-whisper:" + productionItemId}
    )
  `;
  console.log("Enqueued transcribe-whisper job.");
}

const start = Date.now();
const tmpPath = join(tmpdir(), `yt-dl-${ITEM_ID}.mp4`);

try {
  const [item] = await sql`
    SELECT id, youtube_id, youtube_url, media_s3_key
    FROM production_items
    WHERE id = ${ITEM_ID}
  `;

  if (!item) throw new Error(`Item not found: ${ITEM_ID}`);
  if (!item.youtube_url) throw new Error(`No youtube_url on item ${ITEM_ID}`);
  if (item.media_s3_key) {
    console.log(`Item already has media_s3_key=${item.media_s3_key} — nothing to do. Pass a different item or clear the key first.`);
    await sql.end();
    process.exit(0);
  }

  console.log(`Downloading YouTube ID=${item.youtube_id} url=${item.youtube_url}`);

  const cookiesFromBrowser = process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim() || null;
  const errors = [];
  let succeeded = false;

  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    await unlink(tmpPath).catch(() => {});
    console.log(`\nTrying strategy: ${strategy.name}`);
    try {
      await runYtDlp({
        url: item.youtube_url,
        outputPath: tmpPath,
        cookiesFromBrowser,
        playerClients: strategy.clients,
      });
      succeeded = true;
      console.log(`Strategy ${strategy.name} succeeded.`);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Strategy ${strategy.name} failed: ${msg.slice(0, 200)}`);
      errors.push(`[${strategy.name}] ${msg}`);
    }
  }

  if (!succeeded) throw new Error(`All strategies failed: ${errors.join(" || ").slice(0, 450)}`);

  const fileStat = await stat(tmpPath);
  const key = buildKey(ITEM_ID, `${item.youtube_id ?? "video"}.mp4`);
  const bucket = bucketName();

  console.log(`\nUploading to S3: bucket=${bucket} key=${key} bytes=${fileStat.size}`);

  const upload = new Upload({
    client: s3Client(),
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(tmpPath),
      ContentType: "video/mp4",
    },
  });
  upload.on("httpUploadProgress", (p) => {
    if (p.total) process.stdout.write(`\r  ${Math.round((p.loaded / p.total) * 100)}%`);
  });
  await upload.done();
  console.log(`\nS3 upload complete.`);

  await sql`
    UPDATE production_items SET
      media_s3_bucket = ${bucket},
      media_s3_key = ${key},
      media_s3_uploaded_at = NOW(),
      media_size_bytes = ${fileStat.size},
      media_content_type = 'video/mp4',
      youtube_download_source = 'yt-dlp',
      youtube_download_error = NULL,
      youtube_download_attempts = youtube_download_attempts + 1
    WHERE id = ${ITEM_ID}
  `;
  console.log(`DB updated: media_s3_key=${key}`);

  await enqueueWhisper(ITEM_ID);

  console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  await sql`
    UPDATE production_items SET
      youtube_download_error = ${String(err instanceof Error ? err.message : err).slice(0, 500)},
      youtube_download_attempts = youtube_download_attempts + 1
    WHERE id = ${ITEM_ID}
  `;
  process.exit(1);
} finally {
  await unlink(tmpPath).catch(() => {});
  await sql.end();
}
