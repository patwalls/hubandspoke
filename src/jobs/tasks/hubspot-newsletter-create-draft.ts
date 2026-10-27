// Worker-only: push a ready newsletter draft into HubSpot portal 53 as an
// UNSENT draft marketing email (feature flag `newsletterDrafter`). Enqueued by
// `POST /api/newsletter-drafts/[id]/hubspot`. The email is rendered in full
// (hubspot-push.ts → renderEmailBody — the same HTML the editor's canvas
// shows) and fills the copy's one Hub & Spoke email module; HubSpot adds the
// footer. Idempotent: a draft that already has `hubspot_email_id` is skipped,
// so a retry never makes a second email ("Update in HubSpot" refills it
// instead: hubspot-newsletter-update-draft). Never publishes, schedules or
// sends. See docs/automation.md → hubspot-newsletter-create-draft.
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { createDraftEmailFromTemplate } from "@/lib/hubspot-marketing-email";
import { loadHubspotPush, type HubspotPushLoad } from "@/lib/services/newsletter-drafter/hubspot-push";
import { advanceNewsletterItem } from "@/lib/services/newsletter-drafter/queue-status";

export interface HubspotNewsletterCreateDraftPayload {
  newsletterDraftId: string;
}

export const hubspotNewsletterCreateDraftTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId } = rawPayload as HubspotNewsletterCreateDraftPayload;
  const fail = async (message: string) => {
    await db
      .update(newsletterDrafts)
      .set({ hubspotStatus: "failed", hubspotError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, newsletterDraftId));
    helpers.logger.info(`hubspot-newsletter-create-draft: ${newsletterDraftId} failed: ${message}`);
  };

  let loaded: HubspotPushLoad;
  try {
    loaded = await loadHubspotPush(newsletterDraftId);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!loaded.ok) {
    if (!loaded.found) return helpers.logger.info(`hubspot-newsletter-create-draft: ${newsletterDraftId} not found`);
    return fail(loaded.problem);
  }
  const { row, templateEmailId, name, html, pushedText } = loaded.push;
  if (row.hubspotEmailId) return helpers.logger.info(`hubspot-newsletter-create-draft: ${row.id} already has email ${row.hubspotEmailId}`);

  try {
    const email = await createDraftEmailFromTemplate({ templateEmailId, name, subject: row.subject, previewText: row.previewText, html });
    await db
      .update(newsletterDrafts)
      .set({ hubspotEmailId: email.id, hubspotEmailUrl: email.editUrl, hubspotStatus: "created", hubspotError: null, hubspotPushedText: pushedText, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    await advanceNewsletterItem(row.id, "Ready To Publish");
    helpers.logger.info(`hubspot-newsletter-create-draft: ${row.id} → HubSpot email ${email.id}`);
  } catch (err) {
    // Not re-thrown: a HubSpot 4xx won't fix itself on retry, and a retry
    // after a clone that succeeded would leave a second email behind. The
    // page shows the error; the user retries explicitly.
    await fail((err as Error).message);
  }
};
