// Worker-only: push a ready newsletter draft into HubSpot portal 53 as an
// UNSENT draft marketing email (feature flag `newsletterDrafter`). Enqueued by
// `POST /api/newsletter-drafts/[id]/hubspot`. Idempotent: a draft that already
// has `hubspot_email_id` is skipped, so a retry never makes a second email.
// Never publishes, schedules or sends. See docs/automation.md →
// hubspot-newsletter-create-draft.
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts } from "@/lib/db/schema";
import { createDraftEmailFromTemplate, templateEmailIdFor } from "@/lib/hubspot-marketing-email";
import { markdownToEmailHtml } from "@/lib/newsletter-email-html";

export interface HubspotNewsletterCreateDraftPayload {
  newsletterDraftId: string;
}

export const hubspotNewsletterCreateDraftTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId } = rawPayload as HubspotNewsletterCreateDraftPayload;
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      status: newsletterDrafts.status,
      subject: newsletterDrafts.subject,
      bodyMarkdown: newsletterDrafts.bodyMarkdown,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
      createdAt: newsletterDrafts.createdAt,
      formatName: formats.name,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);

  if (!row) return helpers.logger.info(`hubspot-newsletter-create-draft: ${newsletterDraftId} not found`);
  if (row.hubspotEmailId) return helpers.logger.info(`hubspot-newsletter-create-draft: ${row.id} already has email ${row.hubspotEmailId}`);

  const fail = async (message: string) => {
    await db
      .update(newsletterDrafts)
      .set({ hubspotStatus: "failed", hubspotError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    helpers.logger.info(`hubspot-newsletter-create-draft: ${row.id} failed: ${message}`);
  };

  if (row.status !== "ready" || !row.subject || !row.bodyMarkdown) return fail("draft is not ready");
  const templateEmailId = templateEmailIdFor(row.formatName);
  if (!templateEmailId) return fail(`no HubSpot template email configured for "${row.formatName}" (HUBSPOT_NEWSLETTER_TEMPLATE_EMAILS)`);

  try {
    const email = await createDraftEmailFromTemplate({
      templateEmailId,
      name: `${row.formatName} — ${row.subject} (${new Date().toISOString().slice(0, 10)})`,
      subject: row.subject,
      bodyHtml: markdownToEmailHtml(row.bodyMarkdown),
    });
    await db
      .update(newsletterDrafts)
      .set({ hubspotEmailId: email.id, hubspotEmailUrl: email.editUrl, hubspotStatus: "created", hubspotError: null, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    helpers.logger.info(`hubspot-newsletter-create-draft: ${row.id} → HubSpot email ${email.id}`);
  } catch (err) {
    // Not re-thrown: a HubSpot 4xx won't fix itself on retry, and a retry
    // after a clone that succeeded would leave a second email behind. The
    // page shows the error; the user retries explicitly.
    await fail((err as Error).message);
  }
};
