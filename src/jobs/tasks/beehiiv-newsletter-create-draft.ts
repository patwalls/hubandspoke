// Worker-only: push a ready How-To draft into beehiiv (Futurepedia) as an
// UNSENT DRAFT post (feature flag `newsletterDrafter`). Enqueued by
// `POST /api/newsletter-drafts/[id]/beehiiv`. Idempotent: a draft that already
// has `beehiiv_post_id` is skipped, so a retry never makes a second post.
// Never publishes or schedules — beehiiv.ts refuses any request that could.
// See docs/automation.md → beehiiv.
import type { Task } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { createFuturepediaDraft } from "@/lib/beehiiv";
import { buildBeehiivDraftRequest } from "@/lib/beehiiv-draft";
import { templateFor } from "@/lib/newsletter-template";

export interface BeehiivNewsletterCreateDraftPayload {
  newsletterDraftId: string;
}

export const beehiivNewsletterCreateDraftTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId } = rawPayload as BeehiivNewsletterCreateDraftPayload;
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      status: newsletterDrafts.status,
      subject: newsletterDrafts.subject,
      previewText: newsletterDrafts.previewText,
      sendDate: newsletterDrafts.sendDate,
      sections: newsletterDrafts.sections,
      specialCopy: newsletterDrafts.specialCopy,
      specialSource: newsletterDrafts.specialSource,
      beehiivPostId: newsletterDrafts.beehiivPostId,
      formatName: formats.name,
      formatTemplate: formats.newsletterTemplate,
      youtubeId: sql<string | null>`(SELECT ${productionItems.youtubeId} FROM ${productionItems} WHERE ${productionItems.id} = ${newsletterDrafts.sourceItemId})`,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);

  if (!row) return helpers.logger.info(`beehiiv-newsletter-create-draft: ${newsletterDraftId} not found`);
  if (row.beehiivPostId) return helpers.logger.info(`beehiiv-newsletter-create-draft: ${row.id} already has post ${row.beehiivPostId}`);

  const fail = async (message: string) => {
    await db
      .update(newsletterDrafts)
      .set({ beehiivStatus: "failed", beehiivError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    helpers.logger.info(`beehiiv-newsletter-create-draft: ${row.id} failed: ${message}`);
  };

  if (row.status !== "ready" || !row.subject || !row.sendDate) return fail("draft is not ready");
  const template = templateFor(row.formatName, row.formatTemplate);
  if (!template?.beehiiv) return fail(`"${row.formatName}" has no beehiiv template set up`);
  try {
    const body = buildBeehiivDraftRequest({
      template,
      subject: row.subject,
      previewText: row.previewText,
      sendDate: row.sendDate,
      sections: row.sections,
      sponsor: row.specialCopy ? { copy: row.specialCopy, landingUrl: row.specialSource?.landingUrl ?? null } : null,
      thumbnailUrl: row.youtubeId ? `https://img.youtube.com/vi/${row.youtubeId}/maxresdefault.jpg` : null,
    });
    const post = await createFuturepediaDraft(body);
    await db
      .update(newsletterDrafts)
      .set({ beehiivPostId: post.id, beehiivPostUrl: post.editUrl, beehiivStatus: "created", beehiivError: null, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    helpers.logger.info(`beehiiv-newsletter-create-draft: ${row.id} → beehiiv draft ${post.id}`);
  } catch (err) {
    // Not re-thrown: a retry after a create that went through would leave a second draft.
    await fail((err as Error).message);
  }
};
