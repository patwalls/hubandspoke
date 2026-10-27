// Worker-only: "Update in HubSpot" — refill the draft email a newsletter was
// pushed to with the email as it is now in Hub & Spoke: the body (the same
// Hub & Spoke email module the create fills), subject and preview text.
// Enqueued by `POST /api/newsletter-drafts/[id]/hubspot/update`. Guards
// (hubspot-marketing-email.ts → updateDraftEmail): the email must still be a
// DRAFT in HubSpot (not scheduled, sending or sent), and one edited by hand
// there since the last push is refused unless the editor chose "Replace
// anyway" (`force`). Never publishes, schedules or sends. See
// docs/automation.md → hubspot-newsletter-update-draft.
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { updateDraftEmail } from "@/lib/hubspot-marketing-email";
import { loadHubspotPush, type HubspotPushLoad } from "@/lib/services/newsletter-drafter/hubspot-push";

export interface HubspotNewsletterUpdateDraftPayload {
  newsletterDraftId: string;
  /** Replace the email's content even if it was edited by hand in HubSpot. */
  force?: boolean;
}

export const hubspotNewsletterUpdateDraftTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId, force } = rawPayload as HubspotNewsletterUpdateDraftPayload;
  const fail = async (message: string) => {
    await db
      .update(newsletterDrafts)
      .set({ hubspotStatus: "failed", hubspotError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, newsletterDraftId));
    helpers.logger.info(`hubspot-newsletter-update-draft: ${newsletterDraftId} failed: ${message}`);
  };

  let loaded: HubspotPushLoad;
  try {
    loaded = await loadHubspotPush(newsletterDraftId);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!loaded.ok) {
    if (!loaded.found) return helpers.logger.info(`hubspot-newsletter-update-draft: ${newsletterDraftId} not found`);
    return fail(loaded.problem);
  }
  const { row, templateEmailId, html, pushedText } = loaded.push;
  if (!row.hubspotEmailId) return fail("this newsletter has no HubSpot draft yet — create one first");

  try {
    await updateDraftEmail({ emailId: row.hubspotEmailId, templateEmailId, subject: row.subject, previewText: row.previewText, html, pushedText: row.hubspotPushedText, force: !!force });
    await db
      .update(newsletterDrafts)
      .set({ hubspotStatus: "updated", hubspotError: null, hubspotPushedText: pushedText, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    helpers.logger.info(`hubspot-newsletter-update-draft: ${row.id} → HubSpot email ${row.hubspotEmailId} refilled${force ? " (forced)" : ""}`);
  } catch (err) {
    // Not re-thrown: the editor shows the reason (and "Replace anyway" for a hand-edited email) and the next click runs it again.
    await fail((err as Error).message);
  }
};
