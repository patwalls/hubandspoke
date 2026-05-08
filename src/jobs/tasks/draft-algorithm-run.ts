import type { Task } from "graphile-worker";
import { runDraftAlgorithm } from "@/lib/services/draft-algorithm/run";

export interface DraftAlgorithmRunPayload {
  productionItemId: string;
  /** Override the "already-filled" idempotency guard. Set when an editor
   *  explicitly asks to regenerate a draft that already has content. */
  force?: boolean;
}

/**
 * The Draft Algorithm — background entry point.
 *
 * Fired from the cross-post and repurpose creation routes after the new
 * production_item is committed. Pulls the pillar transcript + view-ranked
 * past captions for the same (brand, post_type), calls the draft agent,
 * writes a new contentDrafts row.
 *
 * Idempotent: bails with `skipped` when a non-seeded caption is already
 * present (auto-fire path runs fire-and-forget; a retry shouldn't clobber
 * editor edits).
 */
export const draftAlgorithmRunTask: Task = async (rawPayload, helpers) => {
  const payload = (rawPayload ?? {}) as DraftAlgorithmRunPayload;
  const { productionItemId, force = false } = payload;
  if (!productionItemId) {
    helpers.logger.error("draft-algorithm-run: missing productionItemId");
    return;
  }

  helpers.logger.info(
    `draft-algorithm-run start item=${productionItemId} force=${force}`,
  );
  try {
    const result = await runDraftAlgorithm(productionItemId, { force });
    helpers.logger.info(
      `draft-algorithm-run done item=${productionItemId} status=${result.status}${
        result.reason ? ` reason=${result.reason}` : ""
      }${result.draftId ? ` draftId=${result.draftId}` : ""}`,
    );
  } catch (err) {
    helpers.logger.error(
      `draft-algorithm-run failed item=${productionItemId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Re-throw so graphile-worker retries with backoff.
    throw err;
  }
};
