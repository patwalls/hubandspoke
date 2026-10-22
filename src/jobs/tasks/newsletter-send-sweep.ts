import type { Task } from "graphile-worker";
import { editionsToCheck, syncNewsletterSendState } from "@/lib/services/newsletter-drafter/send-state";

export interface NewsletterSendCheckPayload {
  newsletterDraftId: string;
}

/**
 * Hourly: look at the few pushed newsletters that are waiting to be scheduled
 * (near their send date) or are past their send time but not yet marked
 * Published. Reads only each email's state; free (no AI, no stats).
 */
export const newsletterSendSweepTask: Task = async (_payload, helpers) => {
  const ids = await editionsToCheck();
  const done: Record<string, number> = {};
  for (const id of ids) {
    try {
      const r = await syncNewsletterSendState(id);
      done[r] = (done[r] ?? 0) + 1;
    } catch (err) {
      helpers.logger.error(`newsletter-send-sweep: ${id}: ${(err as Error).message}`);
    }
  }
  helpers.logger.info(`newsletter-send-sweep: ${ids.length} checked ${JSON.stringify(done)}`);
};

/** One edition, ~10 minutes after its scheduled send time (enqueued when it's seen as scheduled). */
export const newsletterSendCheckTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId } = rawPayload as NewsletterSendCheckPayload;
  const r = await syncNewsletterSendState(newsletterDraftId);
  helpers.logger.info(`newsletter-send-check: ${newsletterDraftId} → ${r}`);
};
