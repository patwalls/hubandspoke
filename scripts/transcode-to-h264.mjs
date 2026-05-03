// Fix codecs on production_item media so the file is uploadable everywhere
// we care about (Descript URL import + Twitter/X). Two failure modes:
//   1. Video is AV1/VP9 → Descript rejects. Full re-encode to H.264.
//   2. Audio is Opus (YouTube's high-quality stream) → Twitter rejects with
//      "Incompatible audio codecs". Audio-only re-encode to AAC.
//
// Three-way branch per item after probing both streams:
//   - h264 + aac    → skip
//   - h264 + other  → audio-only fix (-c:v copy -c:a aac, fast)
//   - other + any   → full re-encode (-c:v libx264 -c:a aac, slow)
//
// Always writes `+faststart` so MP4 streaming clients can begin playback
// before the full file is fetched.
//
// Usage:
//   node scripts/transcode-to-h264.mjs <itemId>      # single item
//   node scripts/transcode-to-h264.mjs --batch       # all yt-dlp candidates
//   node scripts/transcode-to-h264.mjs --batch --dry # probe only, no writes
//
// Idempotent: re-running probes each candidate and skips ones already in
// (h264, aac). The S3 round-trip dominates cost; expect ~6–10h on
// residential bandwidth for the full ~1450-item / ~300 GB sweep.

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

async function probeCodecs(path) {
  // ffmpeg exits non-zero when given only `-i` (no output), but prints
  // stream info to stderr first. Parse both "Video: <codec>" and
  // "Audio: <codec>" lines.
  return new Promise((resolve) => {
    const proc = spawn(ffmpegInstaller.path, ["-hide_banner", "-i", path], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    proc.on("close", () => {
      const v = stderr.match(/Video: ([a-zA-Z0-9_]+)/);
      const a = stderr.match(/Audio: ([a-zA-Z0-9_]+)/);
      resolve({
        video: v ? v[1].toLowerCase() : null,
        audio: a ? a[1].toLowerCase() : null,
      });
    });
    proc.on("error", () => resolve({ video: null, audio: null }));
  });
}

function runFfmpegProc(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegInstaller.path, args, {
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

// Full re-encode: video → H.264, audio → AAC. Used when video codec is
// not H.264 (AV1/VP9). Slow: re-encodes every frame.
async function runFullTranscode(inPath, outPath) {
  return runFfmpegProc([
    "-y",
    "-threads", "2",
    "-i", inPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    "-threads", "2",
    outPath,
  ]);
}

// Audio-only fix: keep video stream byte-for-byte, re-encode audio to
// AAC LC + faststart. Used when video is already H.264 but audio is
// Opus (the YouTube-default-for-Twitter-incompatible case).
async function runAudioFix(inPath, outPath) {
  return runFfmpegProc([
    "-y",
    "-i", inPath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ]);
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

    const { video, audio } = await probeCodecs(inPath);
    const codecLabel = `${video ?? "?"}/${audio ?? "?"}`;
    console.log(`  codec: ${codecLabel}`);

    const videoOk = video === "h264";
    const audioOk = audio === "aac";
    if (videoOk && audioOk) {
      console.log("  skip (h264 + aac)");
      await unlink(inPath).catch(() => {});
      return { outcome: "skipped", codec: codecLabel };
    }

    const mode = videoOk ? "audio-only" : "full";
    if (DRY) {
      console.log(`  dry-run — would ${mode} re-encode from ${codecLabel}`);
      await unlink(inPath).catch(() => {});
      return { outcome: "would-transcode", codec: codecLabel };
    }

    if (mode === "audio-only") {
      console.log(`  audio-only fix (${audio} → aac)`);
      await runAudioFix(inPath, outPath);
    } else {
      console.log(`  full re-encode (${codecLabel} → h264/aac)`);
      await runFullTranscode(inPath, outPath);
    }
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
    return { outcome: "transcoded", codec: codecLabel };
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
  // Probe-then-skip is the resume mechanism: re-running the script
  // probes each candidate and skips ones already in (h264, aac), so we
  // don't need a media_s3_uploaded_at cutoff. Descript items are
  // included — Descript-imported source files can still have Opus audio
  // and need fixing for Twitter.
  const { rows } = await pool.query(
    `SELECT id, title, media_s3_key AS key
       FROM production_items
      WHERE media_s3_key IS NOT NULL
        AND youtube_download_source = 'yt-dlp'
      ORDER BY media_size_bytes ASC NULLS LAST`,
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
