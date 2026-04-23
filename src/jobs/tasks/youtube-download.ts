import { spawn } from "child_process";
import { createReadStream } from "fs";
import { stat, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { Task } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { Upload } from "@aws-sdk/lib-storage";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { bucketName, buildKey, s3Client } from "@/lib/s3";
import { maybeEnqueueDescriptTranscribe } from "@/lib/services/transcribe-after-upload";

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

// Player-client strategies, tried in order until one succeeds. YouTube
// challenges the default `web` client hard from datacenter IPs but is less
// aggressive with embedded/TV clients. `default,-android_sdkless` keeps the
// normal web/android stack minus the client YouTube is actively killing.
// Order matters: start with the strategies most likely to yield a full 1080p
// stream (web), fall through to thinner clients if bot-checked.
const PLAYER_CLIENT_STRATEGIES: ReadonlyArray<{ name: string; clients: string }> = [
  { name: "default_minus_sdkless", clients: "default,-android_sdkless" },
  { name: "tv_embedded", clients: "tv_embedded,web_embedded,mweb" },
  { name: "android_vr_mweb", clients: "android_vr,mweb,web_safari" },
];

/**
 * Downloads one YouTube video to S3 and populates the existing media_s3_*
 * columns on its production_item row. Idempotent: skips if the row already
 * has a mediaS3Key (use `force: true` to override).
 *
 * Failure modes are best-effort — YouTube throttles datacenter IPs hard, and
 * age-gated/geo-blocked videos can't be grabbed without cookies. Each failure
 * bumps youtube_download_attempts + records the error; the sweep stops
 * retrying after 5 tries.
 *
 * Cookies: if YT_DLP_COOKIES is set, its contents are written to /tmp and
 * passed via --cookies. Export once from a logged-in Google account (throwaway
 * recommended) with a browser extension that outputs Netscape cookies.txt.
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
  const cookiesPath = await maybeWriteCookies(productionItemId);
  helpers.logger.info(
    `youtube-download start id=${productionItemId} url=${item.youtubeUrl} cookies=${cookiesPath ? "yes" : "no"}`,
  );

  try {
    const errors: string[] = [];
    let succeeded = false;
    for (const strategy of PLAYER_CLIENT_STRATEGIES) {
      // Wipe any tempfile from a previous failed strategy before retrying.
      await unlink(tmpPath).catch(() => {});
      try {
        await runYtDlp({
          url: item.youtubeUrl,
          outputPath: tmpPath,
          ffmpegPath: ffmpegInstaller.path,
          cookiesPath,
          playerClients: strategy.clients,
          logger: helpers.logger,
        });
        helpers.logger.info(
          `youtube-download yt-dlp ok id=${productionItemId} strategy=${strategy.name}`,
        );
        succeeded = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        helpers.logger.info(
          `youtube-download strategy=${strategy.name} failed: ${msg.slice(0, 200)}`,
        );
        errors.push(`[${strategy.name}] ${msg}`);
      }
    }
    if (!succeeded) {
      throw new Error(`all strategies failed: ${errors.join(" || ").slice(0, 450)}`);
    }

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

    // Now that the full video is in S3, kick off Descript transcription.
    // No-ops when the item already has a transcript or the flag is off.
    await maybeEnqueueDescriptTranscribe(productionItemId);
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
    if (cookiesPath) await unlink(cookiesPath).catch(() => {});
  }
};

async function maybeWriteCookies(productionItemId: string): Promise<string | null> {
  const raw = process.env.YT_DLP_COOKIES;
  if (!raw) return null;
  const path = join(tmpdir(), `yt-dl-cookies-${productionItemId}.txt`);
  await writeFile(path, raw, { mode: 0o600 });
  return path;
}

function runYtDlp(args: {
  url: string;
  outputPath: string;
  ffmpegPath: string;
  cookiesPath: string | null;
  playerClients: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ytArgs = [
      "-f",
      "bv*[height<=1440]+ba/b[height<=1440]",
      // Prefer H.264 over AV1/VP9 — Descript's URL import rejects AV1.
      "-S",
      "vcodec:h264",
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
      "--extractor-args",
      `youtube:player_client=${args.playerClients}`,
      "-o",
      args.outputPath,
    ];
    if (args.cookiesPath) {
      ytArgs.push("--cookies", args.cookiesPath);
    }
    ytArgs.push(args.url);

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
