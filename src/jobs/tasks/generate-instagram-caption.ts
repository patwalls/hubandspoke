import type { Task } from "graphile-worker";
import { runDraftAlgorithm } from "@/lib/services/draft-algorithm/run";

export interface GenerateInstagramCaptionPayload {
  productionItemId: string;
  /** Override the "already-filled" idempotency guard. */
  force?: boolean;
}

/**
 * Forwarder kept under the old task name so any `generate-instagram-caption`
 * jobs still sitting in `graphile_worker.jobs` at deploy time resolve to
 * the new Draft Algorithm instead of failing. New enqueues should target
 * `draft-algorithm-run` directly.
 *
 * The new algorithm handles the IG branch identically to before (IG is in
 * the V1 supported post-types set) — this shim is only here for in-flight
 * queue compatibility and can be deleted in V2 once the queue has drained.
 */
export const generateInstagramCaptionTask: Task = async (rawPayload, helpers) => {
  const payload = (rawPayload ?? {}) as GenerateInstagramCaptionPayload;
  const { productionItemId, force = false } = payload;
  if (!productionItemId) {
    helpers.logger.error("generate-instagram-caption: missing productionItemId");
    return;
  }

  helpers.logger.info(
    `generate-ig-caption (forwarder) item=${productionItemId} force=${force}`,
  );
  try {
    const result = await runDraftAlgorithm(productionItemId, { force });
    helpers.logger.info(
      `generate-ig-caption (forwarder) done item=${productionItemId} status=${result.status}${
        result.reason ? ` reason=${result.reason}` : ""
      }`,
    );
  } catch (err) {
    helpers.logger.error(
      `generate-ig-caption (forwarder) failed item=${productionItemId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
};
