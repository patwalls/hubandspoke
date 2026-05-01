import type { Task } from "graphile-worker";
import { generateClipIdeasForItem } from "@/lib/services/clip-idea-generate";

export interface GenerateClipIdeasPayload {
  productionItemId: string;
}

/**
 * Auto-fire path for clip-idea generation. Enqueued by `whisper-pipeline`
 * after a fresh transcript saves on a long-form YouTube pillar; also the
 * unit of work the backfill script (`scripts/backfill-clip-ideas.mjs`) fans
 * out across historic pillars.
 *
 * Idempotent — the service short-circuits if any clip_ideas row already
 * exists for the pillar, so retries after a Sonnet timeout / DB blip are
 * safe.
 *
 * Cost: one Sonnet call per pillar (~$0.10). The post_type gate inside the
 * service keeps this off short-form transcripts.
 */
export const generateClipIdeasTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } = rawPayload as GenerateClipIdeasPayload;
  const start = Date.now();
  helpers.logger.info(`generate-clip-ideas start item=${productionItemId}`);
  const outcome = await generateClipIdeasForItem(productionItemId);
  if (outcome.status === "ok") {
    helpers.logger.info(
      `generate-clip-ideas ok item=${productionItemId} ideas=${outcome.ideasCreated} batch=${outcome.batchId} (${Date.now() - start}ms)`,
    );
  } else {
    helpers.logger.info(
      `generate-clip-ideas skip item=${productionItemId} reason=${outcome.reason} (${Date.now() - start}ms)`,
    );
  }
};
