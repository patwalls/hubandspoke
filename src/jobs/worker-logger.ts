// graphile-worker logger that keeps the worker dyno under the log drain's
// daily cap (docs/automation.md → Log volume). Same line format as
// graphile's defaultLogger; it only drops two kinds of routine info lines:
//
//   1. graphile's own "Completed task N (name, 12.34ms) with success" for a
//      fast, first-attempt job. A cron fire or a sweep child used to cost
//      three lines (our "start", our result, graphile's success); now it
//      costs one. Slow jobs (renders, syncs) and retried successes keep it.
//   2. A task's own "<task-identifier> start…" line — the result line that
//      follows says the same thing with numbers.
//
// Errors, warnings and failures ("Failed task …" with its stack) always pass.

import { Logger, type LogLevel } from "graphile-worker";

type LogMeta = Record<string, unknown>;

/** Successes at or above this duration keep graphile's completion line. */
export const SLOW_JOB_MS = 10_000;

interface Scope {
  label?: string;
  workerId?: string;
  taskIdentifier?: string;
  jobId?: string;
}

export function shouldLog(
  level: LogLevel,
  message: string,
  scope: Scope,
  meta: LogMeta | undefined,
): boolean {
  if (level !== "info") return level !== "debug" || !!process.env.GRAPHILE_LOGGER_DEBUG;
  if (meta?.success === true) {
    const duration = typeof meta.duration === "number" ? meta.duration : Infinity;
    const attempts = (meta.job as { attempts?: number } | undefined)?.attempts ?? 1;
    return duration >= SLOW_JOB_MS || attempts > 1;
  }
  const task = scope.taskIdentifier;
  if (task && (message === `${task} start` || message.startsWith(`${task} start `))) return false;
  return true;
}

export const workerLogger = new Logger((rawScope) => (level, message, meta) => {
  const scope = rawScope as Scope;
  if (!shouldLog(level, message, scope, meta)) return;
  // graphile's defaultLogger format: "[core] INFO: …" /
  // "[job(worker-abc: clip-render{123})] INFO: …"
  const task = scope.taskIdentifier ? `: ${scope.taskIdentifier}` : "";
  const jobId = scope.jobId ? `{${scope.jobId}}` : "";
  const where = scope.workerId ? `(${scope.workerId}${task}${jobId})` : "";
  const line = `[${scope.label || "core"}${where}] ${level.toUpperCase()}: ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warning") console.warn(line);
  else console.log(line);
});
