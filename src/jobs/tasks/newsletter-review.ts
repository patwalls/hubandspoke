// Worker-only: the editor's AI review of a ready newsletter draft
// (`reviewDraft`, flag `newsletterDrafter`). Enqueued by
// `POST /api/newsletter-drafts/[id]/review`, which marks the draft's `review`
// running first; a draft whose review isn't running is skipped. One Opus
// call. See docs/automation.md → newsletter-review.
import type { Task } from "graphile-worker";
import { reviewDraft } from "@/lib/services/newsletter-drafter/review";

export interface NewsletterReviewPayload {
  newsletterDraftId: string;
}

export const newsletterReviewTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId } = rawPayload as NewsletterReviewPayload;
  const r = await reviewDraft(newsletterDraftId, { signal: helpers.abortSignal, log: (m) => helpers.logger.info(m) });
  helpers.logger.info(`newsletter-review: ${newsletterDraftId} → ${r.ok ? "done" : r.reason}`);
};
