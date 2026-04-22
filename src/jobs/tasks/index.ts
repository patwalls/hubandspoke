// Central task registry. Each key here maps a task name (the string
// Graphile Worker stores in `graphile_worker.jobs.task_identifier`) to a
// `run(payload, helpers)` handler. Add a task by importing its module and
// adding a line here — the worker picks it up next boot.
//
// The `TaskPayloads` type lets `enqueue()` enforce a typed payload per task.

import type { Task } from "graphile-worker";

export interface TaskPayloads {
  // Phase 1 tasks land in follow-up commits.
  "hello": { message?: string };
}

export const helloTask: Task = async (payload, helpers) => {
  const { message = "hello" } = (payload ?? {}) as TaskPayloads["hello"];
  helpers.logger.info(`hello task: ${message}`);
};

export const taskList: Record<keyof TaskPayloads, Task> = {
  hello: helloTask,
};
