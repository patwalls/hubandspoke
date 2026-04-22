import type { Task } from "graphile-worker";
import { finishDescriptTranscriptFetch } from "@/lib/services/transcript-fetch";

export interface TranscriptFinishPayload {
  productionItemId: string;
  publishJobId: string;
  /** ISO timestamp — `Date` doesn't survive JSON serialization to the queue. */
  startedAtIso: string;
}

export const transcriptFinishTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as TranscriptFinishPayload;
  helpers.logger.info(
    `transcript-finish start item=${payload.productionItemId} publishJob=${payload.publishJobId}`
  );
  const result = await finishDescriptTranscriptFetch(
    payload.productionItemId,
    payload.publishJobId,
    new Date(payload.startedAtIso)
  );
  helpers.logger.info(
    `transcript-finish ok item=${payload.productionItemId} segments=${result.segmentCount} words=${result.wordCount}`
  );
};
