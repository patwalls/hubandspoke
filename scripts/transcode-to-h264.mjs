// Re-encode production_item media from AV1/VP9 → H.264 so Descript's URL
// import will accept it. Audio is always re-encoded to AAC to guarantee
// MP4 compatibility.
//
// Usage:
//   node scripts/transcode-to-h264.mjs <itemId>      # single item
//   node scripts/transcode-to-h264.mjs --batch       # all yt-dlp candidates
//   node scripts/transcode-to-h264.mjs --batch --dry # probe only, no writes
//
// In batch mode, only items without an existing descript_project_id are
// considered (files already imported to Descript must have been H.264). Each
// candidate is codec-probed via `ffmpeg -i <presignedUrl>`; items already
// reporting h264 are skipped. Skipping happens before any download, so probe
// cost is just a small range-GET over HTTP.

import { spawn } from "child_process";
import { stat, unlink } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";

const args = process.argv.slice(2);
const BATCH = args.includes("--batch");
const DRY = args.includes("--dry");
const SINGLE_ID = args.find((a) => !a.startsWith("--"));

if (!BATCH && !SINGLE_ID) {
  console.error(
    "Usage: node scripts/transcode-to-h264.mjs <itemId> | --batch [--dry]",
  );
  process.exit(1);
}

const BUCKET = process.env.HUBANDSPOKE_S3_BUCKET;
if (!BUCKET) throw new Error("HUBANDSPOKE_S3_BUCKET not set");

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "off"
      ? false
      : { rejectUnauthorized: false },
});

async function probeCodec(path) {
  // ffmpeg exits non-zero when given only `-i` (no output), but prints
  // stream info to stderr first. We parse "Video: <codec>," out of that.
  return new Promise((resolve) => {
    const proc = spawn(ffmpegInstaller.path, ["-hide_banner", "-i", path], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    proc.on("close", () => {
      const m = stderr.match(/Video: ([a-zA-Z0-9_]+)/);
      resolve(m ? m[1].toLowerCase() : null);
    });
    proc.on("error", () => resolve(null));
  });
}

async function runFfmpeg(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const ffArgs = [
      "-y",
      "-i", inPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outPath,
    ];
    const proc = spawn(ffmpegInstaller.path, ffArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let lastLine = "";
    proc.stderr.on("data", (b) => {
      const lines = b.toString().split(/\r?\n/).filter(Boolean);
      if (lines.length) lastLine = lines[lines.length - 1];
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`ffmpeg exited ${code}: ${lastLine.slice(0, 300)}`));
    });
  });
}

async function transcodeItem({ id, title, key }) {
  const t0 = Date.now();
  console.log(`\n=== ${id} — ${title}`);

  const head = await s3.send(
    new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  console.log(`  source size=${head.ContentLength}`);

  const inPath = join(tmpdir(), `transcode-in-${id}.mp4`);
  const outPath = join(tmpdir(), `transcode-out-${id}.mp4`);

  try {
    const getRes = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    if (!getRes.Body) throw new Error("S3 Get returned no body");
    await pipeline(getRes.Body, createWriteStream(inPath));
    console.log(`  downloaded`);

    const codec = await probeCodec(inPath);
    console.log(`  codec: ${codec ?? "unknown"}`);
    if (codec === "h264") {
      console.log("  skip (already H.264)");
      await unlink(inPath).catch(() => {});
      return { outcome: "skipped", codec };
    }
    if (DRY) {
      console.log(`  dry-run — would transcode from ${codec}`);
      await unlink(inPath).catch(() => {});
      return { outcome: "would-transcode", codec };
    }

    await runFfmpeg(inPath, outPath);
    const outStat = await stat(outPath);
    console.log(`  encoded ${outStat.size} bytes`);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: createReadStream(outPath),
        ContentType: "video/mp4",
      },
    });
    await upload.done();
    await pool.query(
      `UPDATE production_items
         SET media_size_bytes = $2,
             media_content_type = 'video/mp4',
             media_s3_uploaded_at = NOW(),
             updated_at = NOW()
       WHERE id = $1`,
      [id, outStat.size],
    );
    console.log(`  done in ${Math.round((Date.now() - t0) / 1000)}s`);
    return { outcome: "transcoded", codec };
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

async function loadCandidates() {
  if (SINGLE_ID) {
    const { rows } = await pool.query(
      "SELECT id, title, media_s3_key AS key FROM production_items WHERE id = $1",
      [SINGLE_ID],
    );
    return rows;
  }
  // Anything uploaded after the first batch run (2026-04-23 03:00 UTC) has
  // already been transcoded by this script — the UPDATE sets
  // media_s3_uploaded_at = NOW(), so completed items naturally fall out of
  // the candidate set without a per-item probe.
  const { rows } = await pool.query(
    `SELECT id, title, media_s3_key AS key
       FROM production_items
      WHERE media_s3_key IS NOT NULL
        AND descript_project_id IS NULL
        AND youtube_download_source = 'yt-dlp'
        AND media_s3_uploaded_at < '2026-04-23 03:00:00+00'
      ORDER BY media_s3_uploaded_at DESC`,
  );
  return rows;
}

try {
  const candidates = await loadCandidates();
  console.log(`candidates: ${candidates.length}`);

  const stats = { skipped: 0, transcoded: 0, wouldTranscode: 0, failed: 0 };
  for (const row of candidates) {
    try {
      const res = await transcodeItem(row);
      if (res.outcome === "skipped") stats.skipped++;
      else if (res.outcome === "transcoded") stats.transcoded++;
      else if (res.outcome === "would-transcode") stats.wouldTranscode++;
    } catch (err) {
      stats.failed++;
      console.error(
        `  FAILED ${row.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  console.log(`\nsummary ${JSON.stringify(stats)}`);
} finally {
  await pool.end();
}
