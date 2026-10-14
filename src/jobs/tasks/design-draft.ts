// Worker-only: the design editor's FIRST AI draft of a post. It used to run
// inside `GET /api/production-items/[id]/design`, but 15–25s+ of AI work
// crossed Heroku's 30s router limit on slow runs (see docs/automation.md →
// design-draft). The route enqueues this with jobKey `design-draft:<itemId>`
// (unsafe_dedupe, maxAttempts 1) and the editor polls the route until the
// document exists. A failure stays in the job's `last_error` for the route
// to show once; it then removes the job so the next open retries.
import type { Task } from "graphile-worker";
import { draftFirstDesign } from "@/lib/services/design-editor/session";

export interface DesignDraftPayload {
  productionItemId: string;
  /** Who opened the editor — recorded as the document's creator. */
  userId: string;
}

export const designDraftTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as DesignDraftPayload;
  const t0 = Date.now();
  await draftFirstDesign(payload);
  helpers.logger.info(`design-draft: item ${payload.productionItemId} drafted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};
