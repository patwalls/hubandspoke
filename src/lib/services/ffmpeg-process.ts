/**
 * Spawning ffmpeg from a worker task: run an argv with `-progress pipe:1`
 * parsing, and read a source's size/duration from the `-i` banner. Shared by
 * the design editor's tasks (clip-render.ts predates this and keeps its own
 * copies for now).
 */
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { parseProgressSeconds } from "@/lib/clip-editor/ffmpeg-args";
import { parseSourceDimensions, parseSourceDuration } from "@/lib/clip-editor/video-box";

/**
 * ffmpeg reads its inputs from LOCAL FILES on the worker. The dyno's static
 * ffmpeg build (2018) segfaults on any https input (verified 2026-09-19 on a
 * one-off dyno: every `-i https://…` form dies with SIGSEGV in ~150 ms, with
 * or without the reconnect flags), while locally installed builds range-read
 * https fine — which is exactly how this went unnoticed. So every task
 * downloads the source first; the disk is ephemeral and a 1 GB podcast
 * lands in ~15 s from S3.
 */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream), createWriteStream(destPath));
}

export function runFfmpeg(argv: string[], opts: { onProgress?: (renderedSec: number) => void; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegInstaller.path, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : null;
    proc.stdout.on("data", (chunk: Buffer) => {
      const sec = parseProgressSeconds(chunk.toString());
      if (sec !== null) opts.onProgress?.(sec);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? signal}${stderr ? `: ${stderr.trim().slice(-600)}` : ""}`));
    });
  });
}

/** `ffmpeg -i <url>` with no output exits non-zero by design, but prints the
 *  stream banner first — over https that is a ranged read of the header. */
export function probeSource(input: string): Promise<{ width: number; height: number; durationSec: number | null } | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegInstaller.path, ["-hide_banner", "-i", input], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    proc.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-20_000);
    });
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      clearTimeout(timer);
      const dims = parseSourceDimensions(stderr);
      resolve(dims ? { ...dims, durationSec: parseSourceDuration(stderr) } : null);
    });
  });
}
