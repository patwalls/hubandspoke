// Worker-only: "Update in beehiiv" — replace the body of the draft post a
// newsletter was pushed to with the email as it is now in Hub & Spoke (the
// same html block the create sends; title, subject and preview text are
// beehiiv's once pushed and are left alone). Enqueued by
// `POST /api/newsletter-drafts/[id]/beehiiv/update`. Guards (beehiiv.ts →
// updateFuturepediaDraft): the post must still be a draft, and a post whose
// copy was edited by hand in beehiiv since the last push is refused unless
// the editor chose "Replace anyway" (`force`). Never publishes or schedules.
// See docs/automation.md → beehiiv.
import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { updateFuturepediaDraft } from "@/lib/beehiiv";
import { loadBeehiivPush, type BeehiivPushLoad } from "@/lib/services/newsletter-drafter/beehiiv-push";

export interface BeehiivNewsletterUpdateDraftPayload {
  newsletterDraftId: string;
  /** Replace the post's content even if it was edited by hand in beehiiv. */
  force?: boolean;
}

export const beehiivNewsletterUpdateDraftTask: Task = async (rawPayload, helpers) => {
  const { newsletterDraftId, force } = rawPayload as BeehiivNewsletterUpdateDraftPayload;
  const fail = async (message: string) => {
    await db
      .update(newsletterDrafts)
      .set({ beehiivStatus: "failed", beehiivError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, newsletterDraftId));
    helpers.logger.info(`beehiiv-newsletter-update-draft: ${newsletterDraftId} failed: ${message}`);
  };

  let loaded: BeehiivPushLoad;
  try {
    loaded = await loadBeehiivPush(newsletterDraftId);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!loaded.ok) {
    if (!loaded.found) return helpers.logger.info(`beehiiv-newsletter-update-draft: ${newsletterDraftId} not found`);
    return fail(loaded.problem);
  }
  const { row, body, pushedText } = loaded.push;
  if (!row.beehiivPostId) return fail("this newsletter has no beehiiv draft yet — create one first");

  try {
    await updateFuturepediaDraft(row.beehiivPostId, { blocks: body.blocks, content_merge_strategy: "replace" }, { pushedText: row.beehiivPushedText, force: !!force });
    await db
      .update(newsletterDrafts)
      .set({ beehiivStatus: "updated", beehiivError: null, beehiivPushedText: pushedText, updatedAt: new Date() })
      .where(eq(newsletterDrafts.id, row.id));
    helpers.logger.info(`beehiiv-newsletter-update-draft: ${row.id} → beehiiv draft ${row.beehiivPostId} replaced${force ? " (forced)" : ""}`);
  } catch (err) {
    // Not re-thrown: the editor shows the reason (and "Replace anyway" for a hand-edited post) and the next click runs it again.
    await fail((err as Error).message);
  }
};
