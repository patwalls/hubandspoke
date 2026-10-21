// Worker-only: the newsletter drafter's agent run (feature flag
// `newsletterDrafter`). `POST /api/newsletter-drafts` inserts a
// `newsletter_drafts` row in `drafting` and enqueues this with jobKey
// `newsletter-draft:<id>`; the page polls the row until it flips to `ready`
// or `failed`. A run takes minutes (an Opus agent loop reading transcripts
// and case-study pages), so it lives here, not in the request. See
// docs/automation.md → newsletter-draft.
import type { Task } from "graphile-worker";
import { runNewsletterDraft } from "@/lib/services/newsletter-drafter/run";

export interface NewsletterDraftPayload {
  newsletterDraftId: string;
}

export const newsletterDraftTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId } = rawPayload as NewsletterDraftPayload;
  const t0 = Date.now();
  const result = await runNewsletterDraft(newsletterDraftId, { signal: helpers.abortSignal, log: (m) => helpers.logger.info(m) });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.ok) {
    helpers.logger.info(`newsletter-draft: ${newsletterDraftId} ready in ${secs}s (${result.turns} turns, ${result.sources} sources)`);
  } else {
    helpers.logger.info(`newsletter-draft: ${newsletterDraftId} skipped (${result.skipped})`);
  }
};
