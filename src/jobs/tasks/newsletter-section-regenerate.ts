// Worker-only: the newsletter editor's per-section Regenerate (flag
// `newsletterDrafter`). Enqueued by POST /api/newsletter-drafts/[id]/sections/[key]/regenerate
// with jobKey `newsletter-section:<id>:<key>`; the editor polls the draft
// until the key leaves `regenerating`. One attempt: a failed rewrite writes
// the reason to the draft's `error` for the editor to show, and the editor
// retries by clicking again. See docs/automation.md → newsletter-section-regenerate.
import type { Task } from "graphile-worker";
import { regenerateDraftSection } from "@/lib/services/newsletter-drafter/section";

export interface NewsletterSectionRegeneratePayload {
  newsletterDraftId: string;
  sectionKey: string;
  instruction?: string | null;
  /** "Find new story": swap the section to a different story. */
  newStory?: boolean;
}

export const newsletterSectionRegenerateTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId, sectionKey, instruction, newStory } = rawPayload as NewsletterSectionRegeneratePayload;
  const t0 = Date.now();
  const r = await regenerateDraftSection(newsletterDraftId, sectionKey, instruction ?? null, { signal: helpers.abortSignal, newStory: !!newStory, log: (m) => helpers.logger.info(m) });
  helpers.logger.info(
    `newsletter-section-regenerate: ${newsletterDraftId}/${sectionKey}${newStory ? " (new story)" : ""} ${r.ok ? "done" : `skipped (${r.reason})`} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
};
