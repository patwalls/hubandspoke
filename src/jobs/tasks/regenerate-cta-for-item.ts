import type { Task } from "graphile-worker";
import { regenerateCtaForItem } from "@/lib/services/draft-algorithm/regenerate-cta";

export interface RegenerateCtaForItemPayload {
  productionItemId: string;
}

// Generates the reply-CTA field on a newly-created cross-post without
// touching the caption. Enqueued by the cross-post route after
// seedRepostContent writes the verbatim caption. regenerateCtaForItem
// self-skips with no_cta_field for post types that have no CTA slot
// (instagram, tiktok, youtube_shorts), so it is safe to enqueue broadly
// and let the service decide.
export const regenerateCtaForItemTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } =
    rawPayload as RegenerateCtaForItemPayload;
  helpers.logger.info(
    `regenerate-cta-for-item start item=${productionItemId}`,
  );
  const result = await regenerateCtaForItem({
    productionItemId,
    actorUserId: null,
  });
  helpers.logger.info(
    `regenerate-cta-for-item done item=${productionItemId} status=${result.status}${result.reason ? ` reason=${result.reason}` : ""}`,
  );
};
