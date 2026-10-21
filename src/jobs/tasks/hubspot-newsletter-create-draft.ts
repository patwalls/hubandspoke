// Worker-only: push a ready newsletter draft into HubSpot portal 53 as an
// UNSENT draft marketing email (feature flag `newsletterDrafter`). Enqueued by
// `POST /api/newsletter-drafts/[id]/hubspot`. Idempotent: a draft that already
// has `hubspot_email_id` is skipped, so a retry never makes a second email.
// Never publishes, schedules or sends. See docs/automation.md →
// hubspot-newsletter-create-draft.
import type { Task } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts } from "@/lib/db/schema";
import { createDraftEmailFromTemplate } from "@/lib/hubspot-marketing-email";
import { markdownToEmailHtml } from "@/lib/newsletter-email-html";
import { blockMarkdown, hubspotEmailName, templateFor } from "@/lib/newsletter-template";

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
      previewText: newsletterDrafts.previewText,
      sendDate: newsletterDrafts.sendDate,
      sections: newsletterDrafts.sections,
      bodyMarkdown: newsletterDrafts.bodyMarkdown,
      specialCopy: newsletterDrafts.specialCopy,
      specialSource: newsletterDrafts.specialSource,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
      createdAt: newsletterDrafts.createdAt,
      formatName: formats.name,
      formatTemplate: formats.newsletterTemplate,
      brand: newsletterDrafts.brand,
      brandLabel: sql<string | null>`(SELECT ${brands.label} FROM ${brands} WHERE ${brands.slug} = ${newsletterDrafts.brand})`,
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

  if (row.status !== "ready" || !row.subject) return fail("draft is not ready");
  const template = templateFor(row.formatName, row.formatTemplate);
  if (!template?.hubspot) return fail(`"${row.formatName}" has no HubSpot template email set up yet`);
  const sponsor = row.specialCopy ? { copy: row.specialCopy, landingUrl: row.specialSource?.landingUrl ?? null } : null;
  const blocks = blockMarkdown(template, row.sections, sponsor);
  if (Object.keys(blocks).length === 0) return fail("this draft has no sections to send (redraft it with the template)");
  const blockHtml = Object.fromEntries(Object.entries(blocks).map(([id, md]) => [id, markdownToEmailHtml(md)]));

  try {
    const email = await createDraftEmailFromTemplate({
      templateEmailId: template.hubspot.templateEmailId,
      name: hubspotEmailName(template.hubspot.emailName, row.brandLabel ?? row.brand, row.sendDate),
      subject: row.subject,
      previewText: row.previewText,
      blockHtml,
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
