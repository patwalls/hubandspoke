import type { Task } from "graphile-worker";
import { extractVisionForItem } from "@/lib/services/hook-extract/vision";

export interface VisionExtractPayload {
  productionItemId: string;
}

/**
 * One production-item's vision pass: calls Haiku 4.5 on the poster image to
 * extract on-screen hook text + a cover description. Child of the scheduled
 * `vision-extract-sweep`. Idempotent on `vision_extracted_at`.
 */
export const visionExtractTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } = rawPayload as VisionExtractPayload;
  const start = Date.now();
  helpers.logger.info(`vision-extract start item=${productionItemId}`);
  const result = await extractVisionForItem(productionItemId);
  helpers.logger.info(
    `vision-extract ${result.status} item=${productionItemId}${
      result.upgradedHook ? " upgraded-hook" : ""
    }${result.note ? ` note=${result.note}` : ""} (${Date.now() - start}ms)`
  );
};
