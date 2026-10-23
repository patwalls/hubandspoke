// Worker-only: learn a newsletter format's template from its past issues
// (`learnTemplate`, flag `newsletterDrafter`). Enqueued by
// `POST /api/formats/[id]/newsletter-template/learn`. One paid Opus call;
// a row that isn't `pending` is skipped. See docs/automation.md →
// newsletter-template-learn.
import type { Task } from "graphile-worker";
import { learnTemplate } from "@/lib/services/newsletter-drafter/learn";

export interface NewsletterTemplateLearnPayload {
  proposalId: string;
}

export const newsletterTemplateLearnTask: Task = async (rawPayload, helpers) => {
  const { proposalId } = rawPayload as NewsletterTemplateLearnPayload;
  const r = await learnTemplate(proposalId, { signal: helpers.abortSignal, log: (m) => helpers.logger.info(m) });
  helpers.logger.info(`newsletter-template-learn: ${proposalId} → ${r.ok ? "done" : r.reason}`);
};
