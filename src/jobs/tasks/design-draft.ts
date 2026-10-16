// Worker-only: the design editor's AI draft of a post — the FIRST draft and,
// since 2026-10-16, Regenerate (`regenerate: true` + the editor's
// instruction). Both used to run inside the request, but 15–25s+ of AI work
// crossed Heroku's 30s router limit on slow runs, and a draft that
// web-searches the founder takes longer still (see docs/automation.md →
// design-draft). The routes enqueue this with jobKey `design-draft:<itemId>`
// (unsafe_dedupe) and the editor polls `GET …/design` until the document
// (or its new revision) exists. A failure stays in the job's `last_error`
// for the route to show once; it then removes the job so the next try runs.
import type { Task } from "graphile-worker";
import { draftFirstDesign, regenerateDesign } from "@/lib/services/design-editor/session";

export interface DesignDraftPayload {
  productionItemId: string;
  /** Who opened the editor — recorded as the document's creator. */
  userId: string;
  /** Replace the existing document (a new revision) instead of writing the first. */
  regenerate?: boolean;
  /** The editor's steer for a regenerate ("lead with the Reddit moment"). */
  instruction?: string | null;
}

export const designDraftTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as DesignDraftPayload;
  const t0 = Date.now();
  if (payload.regenerate) await regenerateDesign({ productionItemId: payload.productionItemId, instruction: payload.instruction ?? null, userId: payload.userId });
  else await draftFirstDesign(payload);
  helpers.logger.info(`design-draft: item ${payload.productionItemId} ${payload.regenerate ? "regenerated" : "drafted"} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};
