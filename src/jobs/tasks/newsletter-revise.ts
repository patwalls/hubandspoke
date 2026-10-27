// Worker-only: the newsletter editor's whole-email Revise (`reviseDraft`, flag
// `newsletterDrafter`). Enqueued by POST /api/newsletter-drafts/[id]/revise,
// which marks the revisable sections `regenerating` first. One Sonnet call
// plans which sections the note touches; each of those is handed to
// `newsletter-section-regenerate` with its instruction, the rest are released.
// One attempt: a failed plan releases the sections and writes the reason to
// the draft's `error`. See docs/automation.md → newsletter-revise.
import type { Task } from "graphile-worker";
import { reviseDraft } from "@/lib/services/newsletter-drafter/revise";

export interface NewsletterRevisePayload {
  newsletterDraftId: string;
  /** The editor's note for the whole issue (≤ 2000 chars). */
  note: string;
}

export const newsletterReviseTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId, note } = rawPayload as NewsletterRevisePayload;
  const r = await reviseDraft(newsletterDraftId, note, {
    log: (m) => helpers.logger.info(m),
    enqueueSection: async (sectionKey, instruction) => {
      await helpers.addJob(
        "newsletter-section-regenerate",
        { newsletterDraftId, sectionKey, instruction },
        { jobKey: `newsletter-section:${newsletterDraftId}:${sectionKey}`, maxAttempts: 1 },
      );
    },
  });
  helpers.logger.info(`newsletter-revise: ${newsletterDraftId} → ${r.ok ? `revising ${r.revised?.join(", ") || "nothing"}` : r.reason}`);
};
