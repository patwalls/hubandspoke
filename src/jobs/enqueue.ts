// Typed wrapper around graphile-worker's `addJob`, used from the web dyno to
// enqueue work. The worker dyno reads `graphile_worker.jobs` via LISTEN/NOTIFY
// and picks the job up within ~1ms.
//
// The WorkerUtils instance opens its own small pg pool — separate from the
// drizzle `postgres.js` client — because `graphile-worker` expects `pg`
// semantics (advisory locks, NOTIFY). Pool is bounded to `maxPoolSize: 2` per
// dyno; see the connection budget in CLAUDE.md.

import {
  makeWorkerUtils,
  type WorkerUtils,
  type TaskSpec,
} from "graphile-worker";
import type { TaskPayloads } from "./tasks";

// Augment graphile-worker's Tasks registry so addJob is type-checked against
// our TaskPayloads map — callers get "did you mean ..." instead of unknown.
declare module "graphile-worker" {
  interface Tasks extends TaskPayloads {}
}

let utilsPromise: Promise<WorkerUtils> | null = null;

function getUtils(): Promise<WorkerUtils> {
  if (!utilsPromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL not set — cannot enqueue jobs");
    }
    utilsPromise = makeWorkerUtils({
      connectionString,
      maxPoolSize: 2,
    });
  }
  return utilsPromise;
}

export async function enqueue<K extends keyof TaskPayloads>(
  name: K,
  payload: TaskPayloads[K],
  opts?: TaskSpec,
): Promise<void> {
  const utils = await getUtils();
  // Cast is safe: the generic constraint on <K> already enforces that
  // `payload` matches `TaskPayloads[K]` at the call site. The inner cast
  // merely placates TS's inference on graphile-worker's conditional type.
  await utils.addJob(name, payload as never, opts);
}
