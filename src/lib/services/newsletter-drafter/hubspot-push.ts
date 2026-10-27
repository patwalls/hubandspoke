// What a HubSpot push sends for a draft — shared by the create task
// (hubspot-newsletter-create-draft) and the update task
// (hubspot-newsletter-update-draft): the draft + its format read from the DB,
// pending screenshots resolved, and the whole email rendered by
// renderEmailBody (the same HTML the editor's canvas shows). Worker-only (S3 + DB).
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts } from "@/lib/db/schema";
import { htmlToText } from "@/lib/html-text";
import { renderEmailBody } from "@/lib/newsletter-email-html";
import type { DocNode } from "@/lib/newsletter-rich-doc";
import { hubspotEmailName, templateFor } from "@/lib/newsletter-template";
import { resolvePendingScreenshots, screenshotUrlsByKey } from "@/lib/services/newsletter-drafter/screenshots";

export interface HubspotPush {
  row: { id: string; subject: string; previewText: string | null; hubspotEmailId: string | null; hubspotPushedText: string | null };
  templateEmailId: string;
  /** The email's name in HubSpot (the template's `emailName` pattern; set on create only). */
  name: string;
  /** The whole email, as the Hub & Spoke email module holds it. */
  html: string;
  /** The words of that html (html-text.ts), stored on the draft after a push. */
  pushedText: string;
}

/** The push for a draft, or why there is none: not found / not ready / no HubSpot template / nothing to send. */
export type HubspotPushLoad = { ok: true; push: HubspotPush } | { ok: false; problem: string; found: boolean };

export async function loadHubspotPush(newsletterDraftId: string): Promise<HubspotPushLoad> {
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
      layout: newsletterDrafts.layout,
      variables: newsletterDrafts.variables,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
      hubspotPushedText: newsletterDrafts.hubspotPushedText,
      formatName: formats.name,
      formatTemplate: formats.newsletterTemplate,
      brand: newsletterDrafts.brand,
      brandLabel: sql<string | null>`(SELECT ${brands.label} FROM ${brands} WHERE ${brands.slug} = ${newsletterDrafts.brand})`,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);
  if (!row) return { ok: false, problem: "not found", found: false };
  if (row.status !== "ready" || !row.subject) return { ok: false, problem: "draft is not ready", found: true };
  const template = templateFor(row.formatName, row.formatTemplate);
  if (!template?.hubspot) return { ok: false, problem: `"${row.formatName}" has no HubSpot template email set up yet`, found: true };
  const sponsor = row.specialCopy ? { copy: row.specialCopy, landingUrl: row.specialSource?.landingUrl ?? null } : null;
  if (!row.sections.some((s) => s.markdown.trim()) && !sponsor) return { ok: false, problem: "this draft has no sections to send (redraft it with the template)", found: true };
  // Picked screenshots go in as public links; a placeholder with no pick is left out of the email.
  const chosen = await resolvePendingScreenshots(row.id, row.screenshots);
  const shotUrls = await screenshotUrlsByKey(chosen);
  const html = renderEmailBody({ template, sections: row.sections, sponsor, screenshots: { chosen, urlFor: (c) => shotUrls[c.key] ?? null }, personalization: "hubspot", layout: row.layout as DocNode | null, variables: row.variables });
  return {
    ok: true,
    push: {
      row: { id: row.id, subject: row.subject, previewText: row.previewText, hubspotEmailId: row.hubspotEmailId, hubspotPushedText: row.hubspotPushedText },
      templateEmailId: template.hubspot.templateEmailId,
      name: hubspotEmailName(template.hubspot.emailName, row.brandLabel ?? row.brand, row.sendDate),
      html,
      pushedText: htmlToText(html),
    },
  };
}
