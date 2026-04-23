// Central task registry. Each key here maps a task name (the string
// Graphile Worker stores in `graphile_worker.jobs.task_identifier`) to a
// `run(payload, helpers)` handler. Add a task by importing its module and
// adding a line here — the worker picks it up next boot.
//
// The `TaskPayloads` type lets `enqueue()` enforce a typed payload per task.

import type { Task } from "graphile-worker";
import {
  transcriptFinishTask,
  type TranscriptFinishPayload,
} from "./transcript-finish";
import {
  descriptClipResolveTask,
  type DescriptClipResolvePayload,
} from "./descript-clip-resolve";
import {
  clipIdeaPreciseCutTask,
  type ClipIdeaPreciseCutPayload,
} from "./clip-idea-precise-cut";
import {
  notificationSendTask,
  type NotificationSendPayload,
} from "./notification-send";
import { enrichItemTask, type EnrichItemPayload } from "./enrich-item";
import { extractHookTask, type ExtractHookPayload } from "./extract-hook";
import {
  performanceDecayTask,
  notionSyncTask,
  enrichmentSweepTask,
  hookExtractSweepTask,
  matgSyncTask,
  evergreenScanTask,
  crossPostScanTask,
} from "./scheduled";

export interface TaskPayloads {
  "hello": { message?: string };
  "transcript-finish": TranscriptFinishPayload;
  "descript-clip-resolve": DescriptClipResolvePayload;
  "clip-idea-precise-cut": ClipIdeaPreciseCutPayload;
  "notification-send": NotificationSendPayload;
  "enrich-item": EnrichItemPayload;
  "extract-hook": ExtractHookPayload;
  // Scheduled tasks — fired by the crontab in src/jobs/crontab.ts.
  "performance-decay": Record<string, never>;
  "notion-sync": Record<string, never>;
  "enrichment-sweep": Record<string, never>;
  "hook-extract-sweep": Record<string, never>;
  "matg-sync": Record<string, never>;
  "evergreen-scan": Record<string, never>;
  "cross-post-scan": Record<string, never>;
}

const helloTask: Task = async (payload, helpers) => {
  const { message = "hello" } = (payload ?? {}) as TaskPayloads["hello"];
  helpers.logger.info(`hello task: ${message}`);
};

export const taskList: Record<keyof TaskPayloads, Task> = {
  "hello": helloTask,
  "transcript-finish": transcriptFinishTask,
  "descript-clip-resolve": descriptClipResolveTask,
  "clip-idea-precise-cut": clipIdeaPreciseCutTask,
  "notification-send": notificationSendTask,
  "enrich-item": enrichItemTask,
  "extract-hook": extractHookTask,
  "performance-decay": performanceDecayTask,
  "notion-sync": notionSyncTask,
  "enrichment-sweep": enrichmentSweepTask,
  "hook-extract-sweep": hookExtractSweepTask,
  "matg-sync": matgSyncTask,
  "evergreen-scan": evergreenScanTask,
  "cross-post-scan": crossPostScanTask,
};
