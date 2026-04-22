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
  notificationSendTask,
  type NotificationSendPayload,
} from "./notification-send";

export interface TaskPayloads {
  "hello": { message?: string };
  "transcript-finish": TranscriptFinishPayload;
  "descript-clip-resolve": DescriptClipResolvePayload;
  "notification-send": NotificationSendPayload;
}

const helloTask: Task = async (payload, helpers) => {
  const { message = "hello" } = (payload ?? {}) as TaskPayloads["hello"];
  helpers.logger.info(`hello task: ${message}`);
};

export const taskList: Record<keyof TaskPayloads, Task> = {
  "hello": helloTask,
  "transcript-finish": transcriptFinishTask,
  "descript-clip-resolve": descriptClipResolveTask,
  "notification-send": notificationSendTask,
};
