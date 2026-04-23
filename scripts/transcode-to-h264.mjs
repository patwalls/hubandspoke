// Re-encode a production_item's S3 media from whatever codec it's in to H.264
// so Descript's URL import will accept it. Audio is always re-encoded to AAC
// to guarantee MP4 compatibility regardless of the source container.
//
// Usage: node --env-file=.env.local scripts/transcode-to-h264.mjs <itemId>
//        heroku run --app hubandspoke node scripts/transcode-to-h264.mjs <itemId>
//
// After a successful transcode the script probes Descript's import endpoint
// with a presigned GET URL; a non-200 response means Descript still rejects
// the file. The probe project is not persisted on the item.

import { spawn } from "child_process";
import { stat, unlink } from "fs/promises";
import { createReadStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import pg from "pg";

const itemId = process.argv[2];
if (!itemId) {
  console.error("Usage: node scripts/transcode-to-h264.mjs <itemId>");
  process.exit(1);
}

const BUCKET = process.env.HUBANDSPOKE_S3_BUCKET;
if (!BUCKET) throw new Error("HUBANDSPOKE_S3_BUCKET not set");

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "off"
    ? false
    : { rejectUnauthorized: false },
});

const { rows } = await pool.query(
  "SELECT id, title, media_s3_key FROM production_items WHERE id = $1",
  [itemId],
);
if (rows.length === 0) {
  console.error(`item ${itemId} not found`);
  process.exit(1);
}
const { media_s3_key: key, title } = rows[0];
if (!key) {
  console.error(`item ${itemId} has no media_s3_key`);
  process.exit(1);
}
console.log(`[transcode] item=${itemId} title=${title}`);
console.log(`[transcode] key=${key}`);

const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
console.log(
  `[transcode] source size=${head.ContentLength} contentType=${head.ContentType}`,
);

const inPath = join(tmpdir(), `transcode-in-${itemId}.mp4`);
const outPath = join(tmpdir(), `transcode-out-${itemId}.mp4`);

async function cleanup() {
  await unlink(inPath).catch(() => {});
  await unlink(outPath).catch(() => {});
}

try {
  // 1. Download source to /tmp.
  const getRes = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  if (!getRes.Body) throw new Error("S3 Get returned no body");
  await pipeline(getRes.Body, createWriteStream(inPath));
  const inStat = await stat(inPath);
  console.log(`[transcode] downloaded ${inStat.size} bytes`);

  // 2. ffmpeg re-encode: video → H.264 (CRF 22, veryfast), audio → AAC 128k.
  //    Veryfast keeps total wall time to single-digit minutes for ~100MB files
  //    on Heroku's shared CPU; CRF 22 is visually indistinguishable from the
  //    source for our use case (transcripts / clip extraction).
  await new Promise((resolve, reject) => {
    const args = [
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
    console.log(`[transcode] ffmpeg ${args.join(" ")}`);
    const proc = spawn(ffmpegInstaller.path, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let lastLine = "";
    proc.stderr.on("data", (b) => {
      const s = b.toString();
      const lines = s.split(/\r?\n/).filter(Boolean);
      if (lines.length) lastLine = lines[lines.length - 1];
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${lastLine.slice(0, 300)}`));
    });
  });
  const outStat = await stat(outPath);
  console.log(`[transcode] encoded ${outStat.size} bytes`);

  // 3. Upload back to the same key (overwrite).
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
  console.log(`[transcode] uploaded to s3://${BUCKET}/${key}`);

  // 4. Update DB size + content type.
  await pool.query(
    `UPDATE production_items
       SET media_size_bytes = $2,
           media_content_type = 'video/mp4',
           media_s3_uploaded_at = NOW(),
           updated_at = NOW()
     WHERE id = $1`,
    [itemId, outStat.size],
  );
  console.log(`[transcode] db updated`);

  // 5. Probe Descript with a presigned GET URL. We DO NOT persist the project
  //    on the item — this is just a validation round-trip.
  const probeUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: 7200 },
  );
  const probeBody = {
    project_name: `__probe__ ${title}`,
    add_media: { main: { url: probeUrl } },
    add_compositions: [
      { name: `__probe__ ${title}`, clips: [{ media: "main" }] },
    ],
  };
  const probeRes = await fetch(
    "https://descriptapi.com/v1/jobs/import/project_media",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DESCRIPT_API_TOKEN}`,
      },
      body: JSON.stringify(probeBody),
    },
  );
  const probeText = await probeRes.text();
  console.log(`[probe] status=${probeRes.status}`);
  console.log(`[probe] body=${probeText.slice(0, 500)}`);
  if (!probeRes.ok) {
    process.exitCode = 2;
  }
} finally {
  await cleanup();
  await pool.end();
}
