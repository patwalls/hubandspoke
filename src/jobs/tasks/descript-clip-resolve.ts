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
}

const POLL_INTERVAL_MS = 5000;
const DEADLINE_MS = 2 * 60 * 1000;

/**
 * Poll a Descript repurpose-agent job until it stops, extract the resulting
 * compositionId from the agent response, and persist it on the trigger row
 * (+ the derivative production_item if one was created). Replaces the
 * previous fire-and-forget promise at src/app/api/descript/clip-out/route.ts.
 */
export const descriptClipResolveTask: Task = async (rawPayload, helpers) => {
  const { triggerId, jobId, derivativeItemId } =
    rawPayload as DescriptClipResolvePayload;

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const job = await fetchDescriptJob(jobId);
    if (job.job_state === "stopped") {
      const compositionId = extractCompositionIdFromAgentResponse(
        job.result?.agent_response
      );
      await db
        .update(repurposeTriggers)
        .set({ descriptCompositionId: compositionId })
        .where(eq(repurposeTriggers.id, triggerId));
      if (derivativeItemId && compositionId) {
        await db
          .update(productionItems)
          .set({ descriptCompositionId: compositionId })
          .where(eq(productionItems.id, derivativeItemId));
      }
      helpers.logger.info(
        `descript-clip-resolve ok trigger=${triggerId} composition=${compositionId ?? "none"}`
      );
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Descript job ${jobId} did not stop within ${DEADLINE_MS / 1000}s`
  );
};
