// A newsletter edition's queue item, like a design (2026-10-22): it stays in
// the queue (Idea, shown with a "Draft" badge once drafted) however often it's
// drafted, edited and closed, and moves to production — Ready To Publish —
// only when its unsent email draft is created in HubSpot / beehiiv (the
// design editor's "Save & export"). Later: Published by send detection. Only
// ever moves FORWARD, and never touches an item someone set by hand to On
// Hold / Scheduled / Published / Killed (or any custom stage).

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { newsletterQueueTitle, templateFor } from "@/lib/newsletter-template";

export const NEWSLETTER_STAGES = ["Idea", "Assigned", "Review", "Ready To Publish"] as const;
export type NewsletterStage = (typeof NEWSLETTER_STAGES)[number];

/** Stages an item may be moved FROM to reach `to` (the ones before it). Pure; exported for tests. */
export function stagesBefore(to: NewsletterStage): NewsletterStage[] {
  return NEWSLETTER_STAGES.slice(0, NEWSLETTER_STAGES.indexOf(to)) as NewsletterStage[];
}

/** Move the edition's queue item forward to `to`. No-op without a linked item, or when it's already past it. */
export async function advanceNewsletterItem(newsletterDraftId: string, to: NewsletterStage): Promise<void> {
  const [d] = await db
    .select({ itemId: newsletterDrafts.productionItemId })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);
  if (!d?.itemId) return;
  await db
    .update(productionItems)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(productionItems.id, d.itemId), inArray(productionItems.status, stagesBefore(to))));
}

/**
 * Name the edition's queue item what the email tool will call it (see
 * newsletterQueueTitle): the subject for a beehiiv newsletter, the HubSpot
 * email name for a HubSpot one. Called when a draft lands, when its subject is
 * saved, and when a slot's queue item is created. No-op without a linked item,
 * when the name is already right, or once the item is Published (history reads
 * those titles).
 */
export async function syncNewsletterItemTitle(newsletterDraftId: string): Promise<void> {
  const [d] = await db
    .select({
      itemId: newsletterDrafts.productionItemId,
      subject: newsletterDrafts.subject,
      sendDate: newsletterDrafts.sendDate,
      formatName: formats.name,
      formatTemplate: formats.newsletterTemplate,
      brand: newsletterDrafts.brand,
      brandLabel: sql<string | null>`(SELECT ${brands.label} FROM ${brands} WHERE ${brands.slug} = ${newsletterDrafts.brand})`,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);
  if (!d?.itemId) return;
  const title = newsletterQueueTitle(templateFor(d.formatName, d.formatTemplate), {
    brandLabel: d.brandLabel ?? d.brand,
    sendDate: d.sendDate,
    subject: d.subject,
  });
  if (!title) return;
  await db
    .update(productionItems)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(productionItems.id, d.itemId), ne(productionItems.status, "Published"), ne(productionItems.title, title)));
}
