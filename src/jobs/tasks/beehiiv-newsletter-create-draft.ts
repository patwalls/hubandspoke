// Worker-only: push a ready How-To draft into beehiiv (Futurepedia) as an
// UNSENT DRAFT post (feature flag `newsletterDrafter`): the designed email as
// one html block + the poll (beehiiv-draft.ts, via beehiiv-push.ts). Enqueued
// by `POST /api/newsletter-drafts/[id]/beehiiv`. Idempotent: a draft that
// already has `beehiiv_post_id` is skipped, so a retry never makes a second
// post. Never publishes or schedules — beehiiv.ts refuses any request that
// could. See docs/automation.md → beehiiv.
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { createFuturepediaDraft } from "@/lib/beehiiv";
import { advanceNewsletterItem } from "@/lib/services/newsletter-drafter/queue-status";
import { loadBeehiivPush, type BeehiivPushLoad } from "@/lib/services/newsletter-drafter/beehiiv-push";

export interface BeehiivNewsletterCreateDraftPayload {
  newsletterDraftId: string;
}

export const beehiivNewsletterCreateDraftTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId } = rawPayload as BeehiivNewsletterCreateDraftPayload;
  const fail = async (message: string) => {
    await db
      .update(newsletterDrafts)
      .set({ beehiivStatus: "failed", beehiivError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, newsletterDraftId));
    helpers.logger.info(`beehiiv-newsletter-create-draft: ${newsletterDraftId} failed: ${message}`);
  };

  let loaded: BeehiivPushLoad;
  try {
    loaded = await loadBeehiivPush(newsletterDraftId);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!loaded.ok) {
    if (!loaded.found) return helpers.logger.info(`beehiiv-newsletter-create-draft: ${newsletterDraftId} not found`);
    return fail(loaded.problem);
  }
  const { row, body, pushedText } = loaded.push;
  if (row.beehiivPostId) return helpers.logger.info(`beehiiv-newsletter-create-draft: ${row.id} already has post ${row.beehiivPostId}`);

  try {
    // Record the post the moment it exists, so a failed check below can never lead to a second post.
    const post = await createFuturepediaDraft(body, async (p) => {
      await db
        .update(newsletterDrafts)
        .set({ beehiivPostId: p.id, beehiivPostUrl: p.editUrl, beehiivPushedText: pushedText, updatedAt: new Date() })
        .where(eq(newsletterDrafts.id, row.id));
    });
    await db
      .update(newsletterDrafts)
      .set({ beehiivStatus: "created", beehiivError: null, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    await advanceNewsletterItem(row.id, "Ready To Publish");
    helpers.logger.info(`beehiiv-newsletter-create-draft: ${row.id} → beehiiv draft ${post.id}`);
  } catch (err) {
    // Not re-thrown: a retry after a create that went through would leave a second draft.
    await fail((err as Error).message);
  }
};
