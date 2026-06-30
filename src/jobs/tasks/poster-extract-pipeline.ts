// Worker-only ffmpeg pipeline: pull the first frame out of an archived video
// and upload it to S3 as a poster. Mirrors the convention in
// `whisper-pipeline.ts` (ffmpeg + S3 imports stay out of the Next.js bundle).
//
// Why this exists:
// IG's Scrape Creators response sometimes omits `display_url` for reels, so
// the enrichment step lands the .mp4 in S3 but never archives a poster.
// `vision-extract` requires a poster to OCR the on-video burn-in overlay, so
// no poster ⇒ no hook. ffmpeg-decoded frame 0 of the .mp4 IS the cover with
// overlay; same image vision was always supposed to read.

import { spawn } from "child_process";
import { mkdir, readFile, rm, stat } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { bucketName, getPresignedGetUrl, putObject } from "@/lib/s3";
import { downloadToFile, safeUnlink } from "./descript-upload-helpers";

const FFMPEG_TIMEOUT_MS = 60 * 1000; // single frame extract is fast
const POSTER_GET_URL_TTL = 60 * 60;
const POSTER_MAX_BYTES = 5 * 1024 * 1024; // first frame as JPEG; comfortably <1MB usually
const POSTER_PREFIX_FALLBACK = "hubandspoke/uploads";

export class PosterExtractError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "no_media"
      | "download_failed"
      | "ffmpeg_failed"
      | "frame_too_large"
      | "upload_failed"
      | "unknown",
  ) {
    super(message);
    this.name = "PosterExtractError";
  }
}

function posterKeyFor(productionItemId: string): string {
  // Mirror the existing layout used by `enrichment/shared.ts` archives:
  //   <prefix>/<itemId>/<uuid>-poster.jpg
  // so derived posters live next to the .mp4 they were extracted from.
  const prefix = (process.env.HUBANDSPOKE_S3_PREFIX || POSTER_PREFIX_FALLBACK)
    .replace(/\/+$/, "");
  return `${prefix}/${productionItemId}/${randomUUID()}-frame0-poster.jpg`;
}

function runFfmpegExtractFrame(args: {
  inputPath: string;
  outputPath: string;
  logger: { info: (msg: string) => void };
}): Promise<void> {
  return new Promise((resolve, reject) => {
    // -ss 0 before -i seeks to start; -frames:v 1 grabs one frame; -q:v 2 is
    // near-lossless JPEG quality (2 is the recommended high-quality setting,
    // 31 is worst). -an drops audio, -update 1 lets the output filename be a
    // single image. -y overwrites any leftover.
    const ffArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      "0",
      "-i",
      args.inputPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-an",
      "-update",
      "1",
      args.outputPath,
    ];
    const proc = spawn(ffmpegInstaller.path, ffArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(
        new PosterExtractError(
          `ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`,
          "ffmpeg_failed",
        ),
      );
    }, FFMPEG_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new PosterExtractError(
          `ffmpeg spawn error: ${err.message}`,
          "ffmpeg_failed",
        ),
      );
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        args.logger.info("ffmpeg frame extract ok");
        resolve();
      } else {
        reject(
          new PosterExtractError(
            `ffmpeg exited ${code}: ${stderr.slice(0, 500)}`,
            "ffmpeg_failed",
          ),
        );
      }
    });
  });
}

/**
 * Extract the first frame of the archived media object at `mediaS3Key` and
 * upload it as a JPEG poster. Returns the new S3 key. The caller is
 * responsible for writing it to `production_items.posterS3Key`.
 */
export async function extractPosterFromMediaS3(
  mediaS3Key: string,
  productionItemId: string,
  logger: { info: (msg: string) => void } = { info: () => {} },
  // Bucket the source media lives in. Source recordings now land in R2, so the
  // GET presign must target that bucket — defaulting to the AWS S3 bucket would
  // presign a URL for an object that isn't there. Undefined → default S3.
  sourceBucket?: string,
): Promise<{ posterS3Key: string; bucket: string; bytes: number }> {
  const runDir = join(tmpdir(), `poster-extract-${randomUUID()}`);
  await mkdir(runDir, { recursive: true });
  const inputPath = join(runDir, "input.mp4");
  const outputPath = join(runDir, "frame0.jpg");

  try {
    const presignedGet = await getPresignedGetUrl(mediaS3Key, POSTER_GET_URL_TTL, {
      bucket: sourceBucket,
    });
    try {
      await downloadToFile(presignedGet, inputPath);
    } catch (err) {
      throw new PosterExtractError(
        `download from S3 failed: ${err instanceof Error ? err.message : String(err)}`,
        "download_failed",
      );
    }

    await runFfmpegExtractFrame({ inputPath, outputPath, logger });

    const { size } = await stat(outputPath);
    if (size === 0) {
      throw new PosterExtractError("ffmpeg produced empty frame", "ffmpeg_failed");
    }
    if (size > POSTER_MAX_BYTES) {
      throw new PosterExtractError(
        `extracted frame too large: ${size} bytes`,
        "frame_too_large",
      );
    }

    const body = await readFile(outputPath);
    const posterKey = posterKeyFor(productionItemId);
    try {
      await putObject(posterKey, body, "image/jpeg");
    } catch (err) {
      throw new PosterExtractError(
        `S3 upload failed: ${err instanceof Error ? err.message : String(err)}`,
        "upload_failed",
      );
    }

    return { posterS3Key: posterKey, bucket: bucketName(), bytes: size };
  } finally {
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}
