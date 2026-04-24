// Worker-only Whisper pipeline. Split from `src/lib/services/whisper-
// transcribe.ts` so the ffmpeg + OpenAI SDK imports stay out of the Next.js
// bundle (Turbopack can't statically resolve `@ffmpeg-installer/<platform>`
// subpackages when the file is pulled into an API route). Mirrors the
// existing pattern where ffmpeg-touching code lives under `src/jobs/tasks/`
// only — API routes import the lightweight service module, the worker
// imports this one.
//
//   Phase 1 (extractAudioToS3): download archived S3 video, run ffmpeg's
//      segment muxer to produce ~10-min mono 16kHz opus chunks under
//      Whisper's 25 MB per-request cap, upload each chunk to S3.
//   Phase 2 (transcribeFromS3Audio): for each chunk, fetch from S3, call
//      OpenAI Whisper with an item-aware prompt (title + author names +
//      description snippet + optional tail of prior chunk for context),
//      offset chunk-local timestamps by the chunk's global start, merge,
//      upsert the `transcripts` row.

import { createReadStream } from "fs";
import { stat, readdir, mkdir, rm, readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { eq, sql } from "drizzle-orm";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import OpenAI from "openai";
import { db } from "@/lib/db";
import { productionItems, syncLogs, transcripts } from "@/lib/db/schema";
import {
  bucketName,
  getPresignedGetUrl,
  putObject,
} from "@/lib/s3";
import { downloadToFile, safeUnlink } from "./descript-upload-helpers";

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const SEGMENT_SECONDS = 600; // 10 min
// Per-chunk sanity check. Opus @24kbps mono is ~1.8 MB per 10-min chunk;
// bitrate drift shouldn't push us near this, but fail loudly if it does.
const CHUNK_MAX_BYTES = 24 * 1024 * 1024;
const WHISPER_MODEL = "whisper-1";
// Whisper's `prompt` is capped at 224 tokens (~800 chars English).
const PROMPT_MAX_CHARS = 800;
const PROMPT_CONTINUATION_CHARS = 300;

export class WhisperTranscribeError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "no_media"
      | "not_av"
      | "ffmpeg_failed"
      | "audio_too_large"
      | "whisper_failed"
      | "unknown",
  ) {
    super(message);
    this.name = "WhisperTranscribeError";
  }
}

let _openai: OpenAI | null = null;
function openai(): OpenAI {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) {
    throw new WhisperTranscribeError(
      "OPENAI_API_KEY not set",
      "whisper_failed",
    );
  }
  _openai = new OpenAI();
  return _openai;
}

function audioKey(productionItemId: string, runId: string, index: number): string {
  const prefix = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads")
    .replace(/\/+$/, "");
  const suffix = String(index).padStart(3, "0");
  return `${prefix}/audio/${productionItemId}/${runId}-${suffix}.ogg`;
}

/**
 * Build the `prompt` we send to Whisper for this item. Whisper uses this to
 * bias its vocabulary toward proper nouns (author, product, brand names)
 * that it would otherwise mangle — docs:
 * https://platform.openai.com/docs/guides/speech-to-text/prompting
 */
function buildItemPrompt(item: {
  title: string | null;
  description: string | null;
  authorHandle: string | null;
  authorDisplayName: string | null;
}): string {
  const names = new Set<string>();
  if (item.authorDisplayName) names.add(item.authorDisplayName.trim());
  if (item.authorHandle) names.add(item.authorHandle.trim().replace(/^@/, ""));
  const parts: string[] = [];
  if (item.title) parts.push(`Transcript of "${item.title.trim()}".`);
  if (names.size > 0) parts.push(`Featuring ${Array.from(names).join(" and ")}.`);
  if (item.description) {
    const snippet = item.description.replace(/\s+/g, " ").trim().slice(0, 300);
    if (snippet) parts.push(snippet);
  }
  return parts.join(" ").slice(0, PROMPT_MAX_CHARS);
}

function runFfmpegSegmented(args: {
  inputPath: string;
  outputDir: string;
  logger: { info: (msg: string) => void };
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const outPattern = join(args.outputDir, "chunk-%03d.ogg");
    const ffArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      args.inputPath,
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      "24k",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "segment",
      "-segment_format",
      "ogg",
      "-segment_time",
      String(SEGMENT_SECONDS),
      "-reset_timestamps",
      "1",
      outPattern,
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
        new WhisperTranscribeError(
          `ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`,
          "ffmpeg_failed",
        ),
      );
    }, FFMPEG_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new WhisperTranscribeError(
          `ffmpeg spawn error: ${err.message}`,
          "ffmpeg_failed",
        ),
      );
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        args.logger.info("ffmpeg segmented audio extract ok");
        resolve();
      } else {
        reject(
          new WhisperTranscribeError(
            `ffmpeg exited ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
            "ffmpeg_failed",
          ),
        );
      }
    });
  });
}

export interface AudioChunk {
  key: string;
  startSec: number;
}

export interface ExtractAudioResult {
  audioS3Bucket: string;
  audioS3Key: string;
  chunks: AudioChunk[];
  totalBytes: number;
}

export async function extractAudioToS3(
  productionItemId: string,
  logger: { info: (msg: string) => void } = { info: () => {} },
): Promise<ExtractAudioResult> {
  const [item] = await db
    .select({
      mediaS3Key: productionItems.mediaS3Key,
      mediaContentType: productionItems.mediaContentType,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    throw new WhisperTranscribeError(
      `production_item ${productionItemId} not found`,
      "unknown",
    );
  }
  if (!item.mediaS3Key) {
    throw new WhisperTranscribeError(
      `production_item ${productionItemId} has no mediaS3Key`,
      "no_media",
    );
  }
  const ct = item.mediaContentType ?? "";
  if (!ct.startsWith("video/") && !ct.startsWith("audio/")) {
    throw new WhisperTranscribeError(
      `production_item ${productionItemId} mediaContentType=${ct || "null"} is not audio/video`,
      "not_av",
    );
  }

  const runId = randomUUID();
  const sourcePath = join(tmpdir(), `whisper-src-${runId}`);
  const chunkDir = join(tmpdir(), `whisper-chunks-${runId}`);

  try {
    await mkdir(chunkDir, { recursive: true });
    logger.info(
      `whisper extract start item=${productionItemId} key=${item.mediaS3Key}`,
    );
    const getUrl = await getPresignedGetUrl(item.mediaS3Key, 3600);
    await downloadToFile(getUrl, sourcePath);
    await runFfmpegSegmented({
      inputPath: sourcePath,
      outputDir: chunkDir,
      logger,
    });

    const entries = (await readdir(chunkDir))
      .filter((n) => n.startsWith("chunk-") && n.endsWith(".ogg"))
      .sort();
    if (entries.length === 0) {
      throw new WhisperTranscribeError(
        "ffmpeg segment produced zero chunks",
        "ffmpeg_failed",
      );
    }

    const bucket = bucketName();
    const chunks: AudioChunk[] = [];
    let totalBytes = 0;
    for (let i = 0; i < entries.length; i++) {
      const localPath = join(chunkDir, entries[i]);
      const chunkStat = await stat(localPath);
      if (chunkStat.size > CHUNK_MAX_BYTES) {
        throw new WhisperTranscribeError(
          `chunk ${i} is ${chunkStat.size} bytes (> ${CHUNK_MAX_BYTES}) — encoder drifted off target bitrate`,
          "audio_too_large",
        );
      }
      const key = audioKey(productionItemId, runId, i);
      const bytes = await readFile(localPath);
      await putObject(key, bytes, "audio/ogg");
      chunks.push({ key, startSec: i * SEGMENT_SECONDS });
      totalBytes += chunkStat.size;
    }

    logger.info(
      `whisper extract ok item=${productionItemId} chunks=${chunks.length} totalBytes=${totalBytes}`,
    );
    return {
      audioS3Bucket: bucket,
      audioS3Key: chunks[0].key,
      chunks,
      totalBytes,
    };
  } finally {
    await safeUnlink(sourcePath);
    await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface WhisperSaveResult {
  productionItemId: string;
  transcriptId: string;
  segmentCount: number;
  wordCount: number;
  durationSec: number;
  chunkCount: number;
}

interface WhisperVerboseResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

async function callWhisperOnChunk(args: {
  audioPath: string;
  prompt: string;
  logger: { info: (msg: string) => void };
  chunkIndex: number;
}): Promise<WhisperVerboseResponse> {
  args.logger.info(
    `whisper call chunk=${args.chunkIndex} model=${WHISPER_MODEL} promptChars=${args.prompt.length}`,
  );
  const resp = (await openai().audio.transcriptions.create({
    file: createReadStream(args.audioPath),
    model: WHISPER_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
    prompt: args.prompt || undefined,
  })) as unknown as WhisperVerboseResponse;
  return resp;
}

export async function transcribeFromS3Audio(
  productionItemId: string,
  audioS3Key: string,
  audioS3Bucket: string,
  chunks: AudioChunk[] | null,
  logger: { info: (msg: string) => void } = { info: () => {} },
): Promise<WhisperSaveResult> {
  const startedAt = new Date();

  const manifest: AudioChunk[] =
    chunks && chunks.length > 0 ? chunks : [{ key: audioS3Key, startSec: 0 }];

  try {
    const [item] = await db
      .select({
        title: productionItems.title,
        description: productionItems.description,
        authorHandle: productionItems.authorHandle,
        authorDisplayName: productionItems.authorDisplayName,
      })
      .from(productionItems)
      .where(eq(productionItems.id, productionItemId))
      .limit(1);
    const basePrompt = item ? buildItemPrompt(item) : "";

    const mergedSegments: Array<{ startSec: number; endSec: number; text: string }> = [];
    const mergedWords: Array<{ word: string; startSec: number; endSec: number }> = [];
    let mergedFullText = "";
    let language: string | undefined;
    let lastEndSec = 0;

    for (let i = 0; i < manifest.length; i++) {
      const chunk = manifest[i];
      const runId = randomUUID();
      const audioPath = join(tmpdir(), `whisper-dl-${runId}.ogg`);

      try {
        const getUrl = await getPresignedGetUrl(chunk.key, 3600);
        await downloadToFile(getUrl, audioPath);

        const continuation =
          i > 0
            ? mergedFullText.slice(-PROMPT_CONTINUATION_CHARS).trim()
            : "";
        const prompt = [basePrompt, continuation]
          .filter((s) => s.length > 0)
          .join(" ")
          .slice(-PROMPT_MAX_CHARS);

        const resp = await callWhisperOnChunk({
          audioPath,
          prompt,
          logger,
          chunkIndex: i,
        });

        if (!language && resp.language) language = resp.language;

        const offset = chunk.startSec;
        for (const s of resp.segments ?? []) {
          mergedSegments.push({
            startSec: Number(s.start) + offset,
            endSec: Number(s.end) + offset,
            text: s.text.trim(),
          });
        }
        for (const w of resp.words ?? []) {
          mergedWords.push({
            word: w.word,
            startSec: Number(w.start) + offset,
            endSec: Number(w.end) + offset,
          });
        }
        const text = (resp.text ?? "").trim();
        if (text) {
          mergedFullText = mergedFullText ? `${mergedFullText} ${text}` : text;
        }
        if (typeof resp.duration === "number") {
          lastEndSec = Math.max(lastEndSec, offset + resp.duration);
        } else if (resp.segments && resp.segments.length > 0) {
          const last = resp.segments[resp.segments.length - 1];
          lastEndSec = Math.max(lastEndSec, offset + Number(last.end));
        }
      } finally {
        await safeUnlink(audioPath);
      }
    }

    const durationSec = lastEndSec;
    const wordCount =
      mergedWords.length > 0
        ? mergedWords.length
        : mergedFullText.trim().split(/\s+/).filter(Boolean).length;

    const [row] = await db
      .insert(transcripts)
      .values({
        productionItemId,
        source: "whisper",
        model: WHISPER_MODEL,
        language: language ?? "en",
        fullText: mergedFullText,
        segments: mergedSegments,
        words: mergedWords,
        wordCount,
        durationSec: durationSec.toFixed(3),
        audioS3Bucket,
        audioS3Key,
        audioChunks: manifest,
        fetchedAt: startedAt,
        error: null,
      })
      .onConflictDoUpdate({
        target: transcripts.productionItemId,
        set: {
          source: "whisper",
          model: WHISPER_MODEL,
          language: language ?? "en",
          rawVtt: null,
          fullText: mergedFullText,
          segments: mergedSegments,
          words: mergedWords,
          wordCount,
          durationSec: durationSec.toFixed(3),
          audioS3Bucket,
          audioS3Key,
          audioChunks: manifest,
          fetchedAt: startedAt,
          error: null,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: transcripts.id });

    await db.insert(syncLogs).values({
      syncType: "whisper-transcribe",
      status: "success",
      itemsCreated: 1,
      startedAt,
      completedAt: new Date(),
    });

    logger.info(
      `whisper save ok item=${productionItemId} chunks=${manifest.length} segments=${mergedSegments.length} words=${wordCount} duration=${durationSec}s`,
    );

    return {
      productionItemId,
      transcriptId: row.id,
      segmentCount: mergedSegments.length,
      wordCount,
      durationSec,
      chunkCount: manifest.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(syncLogs).values({
      syncType: "whisper-transcribe",
      status: "error",
      errorMessage: message.slice(0, 2000),
      startedAt,
      completedAt: new Date(),
    });
    await db
      .update(transcripts)
      .set({ error: message.slice(0, 1000), updatedAt: sql`now()` })
      .where(eq(transcripts.productionItemId, productionItemId));
    throw err;
  }
}

/**
 * Convenience wrapper for scripts / ad-hoc callers where the ~30s Heroku
 * HTTP timeout doesn't apply. Runs both phases inline.
 */
export async function transcribeWhisperEndToEnd(
  productionItemId: string,
  logger: { info: (msg: string) => void } = { info: () => {} },
): Promise<WhisperSaveResult> {
  const { audioS3Bucket, audioS3Key, chunks } = await extractAudioToS3(
    productionItemId,
    logger,
  );
  return transcribeFromS3Audio(
    productionItemId,
    audioS3Key,
    audioS3Bucket,
    chunks,
    logger,
  );
}
