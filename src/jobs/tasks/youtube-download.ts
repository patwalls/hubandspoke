import { spawn } from "child_process";
import { createReadStream } from "fs";
import { stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { Task } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { Upload } from "@aws-sdk/lib-storage";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { bucketName, buildKey, s3Client } from "@/lib/s3";

export interface YoutubeDownloadPayload {
  productionItemId: string;
  /** Re-download even if `mediaS3Key` is already set (overwrites). */
  force?: boolean;
}

// Resolved at startup; the binary is written here by scripts/install-yt-dlp.mjs
// as a postinstall step. Same location on macOS/Linux.
const YT_DLP_PATH = resolve(process.cwd(), "node_modules/.yt-dlp-bin/yt-dlp");

// Cap per-run wall time. A 90-minute podcast at 1080p is ~1GB; downloading at
// Heroku's ~80 MB/s to AWS backbone is tens of seconds, but yt-dlp can hang on
// throttled formats. Abort if we're still going after this.
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Downloads one YouTube video to S3 and populates the existing media_s3_*
 * columns on its production_item row. Idempotent: skips if the row already
 * has a mediaS3Key (use `force: true` to override).
 *
 * Failure modes are best-effort — YouTube throttles datacenter IPs hard, and
 * age-gated/geo-blocked videos can't be grabbed without cookies. Each failure
 * bumps youtube_download_attempts + records the error, and the sweep stops
 * retrying after 5 tries.
 */
export const youtubeDownloadTask: Task = async (rawPayload, helpers) => {
  const { productionItemId, force } = rawPayload as YoutubeDownloadPayload;
  const startTime = Date.now();

  const [item] = await db
    .select({
      id: productionItems.id,
      youtubeId: productionItems.youtubeId,
      youtubeUrl: productionItems.youtubeUrl,
      mediaS3Key: productionItems.mediaS3Key,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    helpers.logger.error(`youtube-download item not found id=${productionItemId}`);
    return;
  }
  if (!item.youtubeUrl) {
    helpers.logger.info(`youtube-download skip id=${productionItemId} reason=no-youtube-url`);
    return;
  }
  if (item.mediaS3Key && !force) {
    helpers.logger.info(`youtube-download skip id=${productionItemId} reason=already-archived`);
    return;
  }

  const tmpPath = join(tmpdir(), `yt-dl-${productionItemId}.mp4`);
  helpers.logger.info(
    `youtube-download start id=${productionItemId} url=${item.youtubeUrl}`,
  );

  try {
    await runYtDlp({
      url: item.youtubeUrl,
      outputPath: tmpPath,
      ffmpegPath: ffmpegInstaller.path,
      logger: helpers.logger,
    });

    const fileStat = await stat(tmpPath);
    const key = buildKey(productionItemId, `${item.youtubeId ?? "video"}.mp4`);
    const bucket = bucketName();

    helpers.logger.info(
      `youtube-download uploading id=${productionItemId} bytes=${fileStat.size} key=${key}`,
    );

    const upload = new Upload({
      client: s3Client(),
      params: {
        Bucket: bucket,
        Key: key,
        Body: createReadStream(tmpPath),
        ContentType: "video/mp4",
      },
    });
    await upload.done();

    await db
      .update(productionItems)
      .set({
        mediaS3Bucket: bucket,
        mediaS3Key: key,
        mediaS3UploadedAt: new Date(),
        mediaSizeBytes: fileStat.size,
        mediaContentType: "video/mp4",
        youtubeDownloadSource: "yt-dlp",
        youtubeDownloadError: null,
        youtubeDownloadAttempts: sql`${productionItems.youtubeDownloadAttempts} + 1`,
      })
      .where(eq(productionItems.id, productionItemId));

    helpers.logger.info(
      `youtube-download ok id=${productionItemId} bytes=${fileStat.size} (${Date.now() - startTime}ms)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(productionItems)
      .set({
        youtubeDownloadError: msg.slice(0, 500),
        youtubeDownloadAttempts: sql`${productionItems.youtubeDownloadAttempts} + 1`,
      })
      .where(eq(productionItems.id, productionItemId));
    helpers.logger.error(
      `youtube-download failed id=${productionItemId} (${Date.now() - startTime}ms): ${msg}`,
    );
    throw err;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
};

function runYtDlp(args: {
  url: string;
  outputPath: string;
  ffmpegPath: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ytArgs = [
      "-f",
      "bv*[height<=1080]+ba/b[height<=1080]",
      "--merge-output-format",
      "mp4",
      "--ffmpeg-location",
      args.ffmpegPath,
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--restrict-filenames",
      "--concurrent-fragments",
      "4",
      "-o",
      args.outputPath,
      args.url,
    ];

    const proc = spawn(YT_DLP_PATH, ytArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      rejectPromise(
        new Error(`yt-dlp timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`),
      );
    }, DOWNLOAD_TIMEOUT_MS);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`yt-dlp spawn error: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        if (stdout.trim()) args.logger.info(`yt-dlp: ${stdout.trim().slice(0, 300)}`);
        resolvePromise();
      } else {
        // yt-dlp's useful error line is typically the last stderr line.
        const lastErr = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
        rejectPromise(
          new Error(`yt-dlp exited ${code}${lastErr ? `: ${lastErr}` : ""}`),
        );
      }
    });
  });
}
