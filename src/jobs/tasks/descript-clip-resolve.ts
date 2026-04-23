import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import {
  fetchDescriptJob,
  extractCompositionIdFromAgentResponse,
} from "@/lib/descript";

export interface DescriptClipResolvePayload {
  triggerId: string;
  jobId: string;
  derivativeItemId?: string;
  /** Epoch ms. Set on the first invocation; carried forward across re-enqueues. */
  deadlineAt?: number;
}

const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 10 * 60 * 1000;

/**
 * Do one poll of a Descript repurpose-agent job. If it's stopped, write the
 * compositionId. If not, self-re-enqueue with a 5s delay. Keeping each
 * invocation <1s means SIGTERM during a deploy never catches us mid-poll,
 * so the job's lock never leaks.
 */
export const descriptClipResolveTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as DescriptClipResolvePayload;
  const deadlineAt = payload.deadlineAt ?? Date.now() + DEADLINE_MS;

  const job = await fetchDescriptJob(payload.jobId);
  if (job.job_state === "stopped") {
    const compositionId = extractCompositionIdFromAgentResponse(
      job.result?.agent_response,
    );
    await db
      .update(repurposeTriggers)
      .set({ descriptCompositionId: compositionId })
      .where(eq(repurposeTriggers.id, payload.triggerId));
    if (payload.derivativeItemId && compositionId) {
      await db
        .update(productionItems)
        .set({ descriptCompositionId: compositionId })
        .where(eq(productionItems.id, payload.derivativeItemId));
    }
    helpers.logger.info(
      `descript-clip-resolve ok trigger=${payload.triggerId} composition=${compositionId ?? "none"}`,
    );
    return;
  }

  if (Date.now() >= deadlineAt) {
    throw new Error(
      `Descript job ${payload.jobId} did not stop before deadline`,
    );
  }

  await helpers.addJob(
    "descript-clip-resolve",
    { ...payload, deadlineAt },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
};
