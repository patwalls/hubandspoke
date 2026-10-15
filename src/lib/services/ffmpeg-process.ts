/**
 * Spawning ffmpeg from a worker task: run an argv with `-progress pipe:1`
 * parsing, and read a source's size/duration from the `-i` banner. Shared by
 * the clip editor's `clip-render` and the design editor's tasks.
 *
 * Every entry point here is bounded. A worker task that can hang holds a
 * serial queue (`media-heavy`) hostage and survives a graceful shutdown as
 * an orphaned lock — 2026-10-15 lost most of a day of clip renders to
 * exactly that. So: downloads time out, ffmpeg is killed when it stops
 * making progress or runs past a hard cap, and both honor an AbortSignal
 * (pass graphile's `helpers.abortSignal`) so a deploy's SIGTERM turns into a
 * clean failure + retry instead of a 4h stale lock.
 */
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { parseProgressSeconds } from "@/lib/clip-editor/ffmpeg-args";
import { parseSourceDimensions, parseSourceDuration } from "@/lib/clip-editor/video-box";

/** A 1 GB podcast lands from S3 in ~15 s; ten minutes is "the network is gone". */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** ffmpeg reports progress ~2×/s while encoding; three silent minutes is a hang. */
export const FFMPEG_STALL_TIMEOUT_MS = 3 * 60_000;
/** No single render legitimately takes longer than this on a dyno. */
export const FFMPEG_MAX_RUNTIME_MS = 30 * 60_000;

export interface DownloadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * ffmpeg reads its inputs from LOCAL FILES on the worker. The dyno's static
 * ffmpeg build (2018) segfaults on any https input (verified 2026-09-19 on a
 * one-off dyno: every `-i https://…` form dies with SIGSEGV in ~150 ms, with
 * or without the reconnect flags), while locally installed builds range-read
 * https fine — which is exactly how this went unnoticed. So every task
 * downloads the source first; the disk is ephemeral.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const signal = combineSignals(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, opts.signal);
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    throw describeAbort(err, "download", signal);
  }
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeReadableStream),
      createWriteStream(destPath),
      { signal },
    );
  } catch (err) {
    throw describeAbort(err, "download", signal);
  }
}

export interface RunProcessOptions {
  onProgress?: (renderedSec: number) => void;
  /** Kill if no stdout/stderr output for this long. 0 disables. */
  stallTimeoutMs?: number;
  /** Kill unconditionally after this long. 0 disables. */
  maxRuntimeMs?: number;
  /** Kill when this aborts (graceful shutdown). */
  signal?: AbortSignal;
}

export function runFfmpeg(argv: string[], opts: RunProcessOptions = {}): Promise<void> {
  return runWatchedProcess(ffmpegInstaller.path, argv, opts);
}

/**
 * Spawn `bin argv`, resolve on exit 0, reject with the tail of stderr
 * otherwise. Progress lines on stdout feed `onProgress`; ANY output resets
 * the stall timer. Exposed (not ffmpeg-specific) so the watchdogs can be
 * tested with `sleep`.
 */
export function runWatchedProcess(
  bin: string,
  argv: string[],
  opts: RunProcessOptions = {},
): Promise<void> {
  const stallMs = opts.stallTimeoutMs ?? FFMPEG_STALL_TIMEOUT_MS;
  const maxMs = opts.maxRuntimeMs ?? FFMPEG_MAX_RUNTIME_MS;
  return new Promise((resolve, reject) => {
    // Own process group (`detached`) so a kill reaches every descendant:
    // killing only the direct child leaves a grandchild holding the stdio
    // pipes open and `close` never fires. (Seen in CI on Linux, where
    // `sh -c cmd` forks rather than execs; the same shape as an ffmpeg that
    // spawned a helper.) Heroku's SIGTERM on restart still reaches the
    // group — the dyno signals every process, not just the session leader.
    const proc = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderr = "";
    let killReason: string | null = null;
    const startedAt = Date.now();

    const kill = (reason: string) => {
      if (killReason) return;
      killReason = reason;
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };

    let stallTimer: NodeJS.Timeout | null = null;
    const armStall = () => {
      if (!stallMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => kill(`stalled: no output for ${Math.round(stallMs / 1000)}s`),
        stallMs,
      );
    };
    const maxTimer = maxMs
      ? setTimeout(() => kill(`exceeded max runtime of ${Math.round(maxMs / 1000)}s`), maxMs)
      : null;
    const onAbort = () => kill(`aborted: ${abortReason(opts.signal)}`);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    armStall();
    proc.stdout.on("data", (chunk: Buffer) => {
      armStall();
      const sec = parseProgressSeconds(chunk.toString());
      if (sec !== null) opts.onProgress?.(sec);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      armStall();
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    const cleanup = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (maxTimer) clearTimeout(maxTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    proc.on("error", (err) => {
      cleanup();
      reject(err);
    });
    proc.on("close", (code, signal) => {
      cleanup();
      if (code === 0) return resolve();
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      const why = killReason
        ? `process killed (${killReason}) after ${elapsed}s`
        : `process exited ${code ?? signal}`;
      reject(new Error(`${why}${stderr ? `: ${stderr.trim().slice(-600)}` : ""}`));
    });
  });
}

/** `ffmpeg -i <url>` with no output exits non-zero by design, but prints the
 *  stream banner first — over https that is a ranged read of the header. */
export function probeSource(input: string): Promise<{ width: number; height: number; durationSec: number | null; hasAudio: boolean } | null> {
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
      resolve(dims ? { ...dims, durationSec: parseSourceDuration(stderr), hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr) } : null);
    });
  });
}

function combineSignals(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([timeout, outer]) : timeout;
}

function abortReason(signal?: AbortSignal): string {
  const r: unknown = signal?.reason;
  if (r instanceof Error) return r.name === "TimeoutError" ? "timed out" : r.message || r.name;
  return r ? String(r) : "worker shutting down";
}

/** Turn the DOMException soup fetch/pipeline throw on abort into one clear message. */
function describeAbort(err: unknown, what: string, signal: AbortSignal): Error {
  if (signal.aborted) return new Error(`${what} ${abortReason(signal)}`);
  return err instanceof Error ? err : new Error(String(err));
}
