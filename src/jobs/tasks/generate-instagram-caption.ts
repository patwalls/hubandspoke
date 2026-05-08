import type { Task } from "graphile-worker";
import { generateInstagramCaptionForItem } from "@/lib/services/generate-instagram-caption";

export interface GenerateInstagramCaptionPayload {
  productionItemId: string;
  /** Override the "already-filled" idempotency guard. Set when an editor
   *  explicitly asks to regenerate a caption that already has content. */
  force?: boolean;
}

/**
 * Auto-generate the Instagram-platform caption when a draft is seeded for
 * an IG post type (Reel / Post / Story). Reads the pillar transcript +
 * past published captions for the same format, calls the draft agent, and
 * writes a new contentDrafts row.
 *
 * Fired from `seedRepostContent` (in src/lib/services/repost-seed.ts) and
 * any other path that creates an IG draft. Idempotent: bails with
 * `skipped` when a non-seeded caption is already present.
 */
export const generateInstagramCaptionTask: Task = async (rawPayload, helpers) => {
  const payload = (rawPayload ?? {}) as GenerateInstagramCaptionPayload;
  const { productionItemId, force = false } = payload;
  if (!productionItemId) {
    helpers.logger.error("generate-instagram-caption: missing productionItemId");
    return;
  }

  helpers.logger.info(
    `generate-ig-caption start item=${productionItemId} force=${force}`,
  );
  try {
    const result = await generateInstagramCaptionForItem(productionItemId, {
      force,
    });
    helpers.logger.info(
      `generate-ig-caption done item=${productionItemId} status=${result.status}${
        result.reason ? ` reason=${result.reason}` : ""
      }${result.draftId ? ` draftId=${result.draftId}` : ""}`,
    );
  } catch (err) {
    // Re-throw so graphile-worker sees the failure and retries with backoff.
    helpers.logger.error(
      `generate-ig-caption failed item=${productionItemId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
};
