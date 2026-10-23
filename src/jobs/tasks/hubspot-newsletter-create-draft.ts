// Worker-only: push a ready newsletter draft into HubSpot portal 53 as an
// UNSENT draft marketing email (feature flag `newsletterDrafter`). Enqueued by
// `POST /api/newsletter-drafts/[id]/hubspot`. The email is rendered here, in
// full (renderEmailBody — the same HTML the editor's canvas shows), and fills
// the copy's one rich-text block; HubSpot adds the footer. Idempotent: a
// draft that already has `hubspot_email_id` is skipped, so a retry never
// makes a second email. Never publishes, schedules or sends. See
// docs/automation.md → hubspot-newsletter-create-draft.
import type { Task } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts } from "@/lib/db/schema";
import { createDraftEmailFromTemplate } from "@/lib/hubspot-marketing-email";
import { renderEmailBody } from "@/lib/newsletter-email-html";
import { resolvePendingScreenshots, screenshotUrlsByKey } from "@/lib/services/newsletter-drafter/screenshots";
import { advanceNewsletterItem } from "@/lib/services/newsletter-drafter/queue-status";
import { hubspotEmailName, templateFor } from "@/lib/newsletter-template";

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
      screenshots: newsletterDrafts.screenshots,
      specialCopy: newsletterDrafts.specialCopy,
      specialSource: newsletterDrafts.specialSource,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
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
  // Picked screenshots go in as public links; a placeholder with no pick is left out of the email.
  const chosen = await resolvePendingScreenshots(row.id, row.screenshots);
  const shotUrls = await screenshotUrlsByKey(chosen);
  const html = renderEmailBody({ template, sections: row.sections, sponsor, screenshots: { chosen, urlFor: (c) => shotUrls[c.key] ?? null }, personalization: "hubspot" });
  if (!row.sections.some((s) => s.markdown.trim()) && !sponsor) return fail("this draft has no sections to send (redraft it with the template)");

  try {
    const email = await createDraftEmailFromTemplate({
      templateEmailId: template.hubspot.templateEmailId,
      name: hubspotEmailName(template.hubspot.emailName, row.brandLabel ?? row.brand, row.sendDate),
      subject: row.subject,
      previewText: row.previewText,
      html,
    });
    await db
      .update(newsletterDrafts)
      .set({ hubspotEmailId: email.id, hubspotEmailUrl: email.editUrl, hubspotStatus: "created", hubspotError: null, updatedAt: new Date() })
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
