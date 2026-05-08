// Central task registry. Each key here maps a task name (the string
// Graphile Worker stores in `graphile_worker.jobs.task_identifier`) to a
// `run(payload, helpers)` handler. Add a task by importing its module and
// adding a line here — the worker picks it up next boot.
//
// The `TaskPayloads` type lets `enqueue()` enforce a typed payload per task.

import type { Task } from "graphile-worker";
import {
  descriptClipResolveTask,
  type DescriptClipResolvePayload,
} from "./descript-clip-resolve";
import {
  descriptPublishAndArchiveTask,
  type DescriptPublishAndArchivePayload,
} from "./descript-publish-and-archive";
import {
  clipIdeaPreciseCutTask,
  type ClipIdeaPreciseCutPayload,
} from "./clip-idea-precise-cut";
import {
  transcribeWhisperTask,
  type TranscribeWhisperPayload,
} from "./transcribe-whisper";
import {
  notificationSendTask,
  type NotificationSendPayload,
} from "./notification-send";
import { enrichItemTask, type EnrichItemPayload } from "./enrich-item";
import { extractHookTask, type ExtractHookPayload } from "./extract-hook";
import { hookFallbackTask, type HookFallbackPayload } from "./hook-fallback";
import { visionExtractTask, type VisionExtractPayload } from "./vision-extract";
import { extractPosterTask, type ExtractPosterPayload } from "./extract-poster";
import { hookDispatchTask, type HookDispatchPayload } from "./hook-dispatch";
import {
  youtubeDownloadTask,
  type YoutubeDownloadPayload,
} from "./youtube-download";
import { youtubeDownloadSweepTask } from "./youtube-download-sweep";
import {
  accountRefreshTask,
  type AccountRefreshPayload,
} from "./account-refresh";
import {
  accountContentSyncTask,
  type AccountContentSyncPayload,
} from "./account-content-sync";
import {
  performanceDecayTask,
  notionSyncTask,
  enrichmentSweepTask,
  hookExtractSweepTask,
  hookFallbackSweepTask,
  visionExtractSweepTask,
  extractPosterSweepTask,
  hookDispatchSweepTask,
  evergreenScanTask,
  accountRefreshSweepTask,
  accountContentSyncSweepTask,
  dailyScorecardEmailTask,
  scCreditsWatchTask,
} from "./scheduled";
import { thresholdMonitorSweepTask } from "./threshold-monitor-sweep";
import {
  refreshItemMetricsTask,
  type RefreshItemMetricsPayload,
} from "./refresh-item-metrics";
import {
  captureVelocitySnapshotTask,
  type CaptureVelocitySnapshotPayload,
} from "./capture-velocity-snapshot";
import {
  generateClipIdeasTask,
  type GenerateClipIdeasPayload,
} from "./generate-clip-ideas";
import {
  typefullyCreateDraftTask,
  type TypefullyCreateDraftPayload,
} from "./typefully-create-draft";
import {
  generateInstagramCaptionTask,
  type GenerateInstagramCaptionPayload,
} from "./generate-instagram-caption";
import {
  draftAlgorithmRunTask,
  type DraftAlgorithmRunPayload,
} from "./draft-algorithm-run";

export interface TaskPayloads {
  "hello": { message?: string };
  "descript-clip-resolve": DescriptClipResolvePayload;
  "descript-publish-and-archive": DescriptPublishAndArchivePayload;
  "clip-idea-precise-cut": ClipIdeaPreciseCutPayload;
  "transcribe-whisper": TranscribeWhisperPayload;
  "notification-send": NotificationSendPayload;
  "enrich-item": EnrichItemPayload;
  "extract-hook": ExtractHookPayload;
  "hook-fallback": HookFallbackPayload;
  "vision-extract": VisionExtractPayload;
  "extract-poster": ExtractPosterPayload;
  "hook-dispatch": HookDispatchPayload;
  "youtube-download": YoutubeDownloadPayload;
  "account-refresh": AccountRefreshPayload;
  "account-content-sync": AccountContentSyncPayload;
  "refresh-item-metrics": RefreshItemMetricsPayload;
  "capture-velocity-snapshot": CaptureVelocitySnapshotPayload;
  "generate-clip-ideas": GenerateClipIdeasPayload;
  "typefully-create-draft": TypefullyCreateDraftPayload;
  "generate-instagram-caption": GenerateInstagramCaptionPayload;
  "draft-algorithm-run": DraftAlgorithmRunPayload;
  // Scheduled tasks — fired by the crontab in src/jobs/crontab.ts.
  "performance-decay": Record<string, never>;
  "notion-sync": Record<string, never>;
  "enrichment-sweep": Record<string, never>;
  "hook-extract-sweep": Record<string, never>;
  "hook-fallback-sweep": Record<string, never>;
  "vision-extract-sweep": Record<string, never>;
  "extract-poster-sweep": Record<string, never>;
  "hook-dispatch-sweep": Record<string, never>;
  "evergreen-scan": Record<string, never>;
  "youtube-download-sweep": Record<string, never>;
  "account-refresh-sweep": Record<string, never>;
  "account-content-sync-sweep": Record<string, never>;
  "threshold-monitor-sweep": Record<string, never>;
  "daily-scorecard-email": Record<string, never>;
  "sc-credits-watch": Record<string, never>;
}

const helloTask: Task = async (payload, helpers) => {
  const { message = "hello" } = (payload ?? {}) as TaskPayloads["hello"];
  helpers.logger.info(`hello task: ${message}`);
};

export const taskList: Record<keyof TaskPayloads, Task> = {
  "hello": helloTask,
  "descript-clip-resolve": descriptClipResolveTask,
  "descript-publish-and-archive": descriptPublishAndArchiveTask,
  "clip-idea-precise-cut": clipIdeaPreciseCutTask,
  "transcribe-whisper": transcribeWhisperTask,
  "notification-send": notificationSendTask,
  "enrich-item": enrichItemTask,
  "extract-hook": extractHookTask,
  "hook-fallback": hookFallbackTask,
  "vision-extract": visionExtractTask,
  "extract-poster": extractPosterTask,
  "hook-dispatch": hookDispatchTask,
  "youtube-download": youtubeDownloadTask,
  "account-refresh": accountRefreshTask,
  "account-content-sync": accountContentSyncTask,
  "refresh-item-metrics": refreshItemMetricsTask,
  "capture-velocity-snapshot": captureVelocitySnapshotTask,
  "generate-clip-ideas": generateClipIdeasTask,
  "typefully-create-draft": typefullyCreateDraftTask,
  "generate-instagram-caption": generateInstagramCaptionTask,
  "draft-algorithm-run": draftAlgorithmRunTask,
  "performance-decay": performanceDecayTask,
  "notion-sync": notionSyncTask,
  "enrichment-sweep": enrichmentSweepTask,
  "hook-extract-sweep": hookExtractSweepTask,
  "hook-fallback-sweep": hookFallbackSweepTask,
  "vision-extract-sweep": visionExtractSweepTask,
  "extract-poster-sweep": extractPosterSweepTask,
  "hook-dispatch-sweep": hookDispatchSweepTask,
  "evergreen-scan": evergreenScanTask,
  "youtube-download-sweep": youtubeDownloadSweepTask,
  "account-refresh-sweep": accountRefreshSweepTask,
  "account-content-sync-sweep": accountContentSyncSweepTask,
  "threshold-monitor-sweep": thresholdMonitorSweepTask,
  "daily-scorecard-email": dailyScorecardEmailTask,
  "sc-credits-watch": scCreditsWatchTask,
};
