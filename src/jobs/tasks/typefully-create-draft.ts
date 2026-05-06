import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import {
  createTypefullyDraft,
  type TypefullyPlatform,
} from "@/lib/typefully";
import { recordToolAction } from "@/lib/services/content-events";

export interface TypefullyCreateDraftPayload {
  productionItemId: string;
}

/**
 * Auto-create a Typefully draft for a freshly-inserted X or LinkedIn item.
 * Re-checks every gate inside the task so a stale enqueue (e.g. user filled
 * publishedLink between insert and run) becomes a graceful noop.
 *
 * Soft-skips (logs and returns) when:
 *  - The item is gone, or already has a Typefully draft id (idempotent re-run)
 *  - postType isn't x or linkedin
 *  - publishedLink is set (already live on the platform — no point drafting)
 *  - contentBody is empty (nothing to send; redrive once user fills it)
 *  - The item's account has no typefullySocialSetId configured
 *
 * Hard-fails (throws → graphile-worker retries) on Typefully API errors.
 */
export const typefullyCreateDraftTask: Task = async (rawPayload, helpers) => {
  const { productionItemId } = rawPayload as TypefullyCreateDraftPayload;

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      postType: productionItems.postType,
      contentBody: productionItems.contentBody,
      publishedLink: productionItems.publishedLink,
      typefullyDraftId: productionItems.typefullyDraftId,
      accountId: productionItems.accountId,
      editorUserId: productionItems.editorUserId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    helpers.logger.info(
      `[typefully] item ${productionItemId} not found — skip`,
    );
    return;
  }
  if (item.typefullyDraftId) {
    helpers.logger.info(
      `[typefully] item ${productionItemId} already has draft ${item.typefullyDraftId} — skip`,
    );
    return;
  }
  if (item.postType !== "x" && item.postType !== "linkedin") {
    helpers.logger.info(
      `[typefully] item ${productionItemId} postType=${item.postType ?? "null"} — skip`,
    );
    return;
  }
  if (item.publishedLink) {
    helpers.logger.info(
      `[typefully] item ${productionItemId} already published — skip`,
    );
    return;
  }
  // Always create a draft, even when contentBody is empty — operators want
  // the empty Typefully shell so they can write the body inside Typefully.
  // Typefully requires text length >= 1; fall back to title, then a single
  // space if both are blank.
  const body = (item.contentBody ?? "").trim();
  const titleFallback = (item.title ?? "").trim();
  const text = body || titleFallback || " ";
  if (!item.accountId) {
    helpers.logger.info(
      `[typefully] item ${productionItemId} has no accountId — skip`,
    );
    return;
  }

  const [account] = await db
    .select({
      typefullySocialSetId: accounts.typefullySocialSetId,
    })
    .from(accounts)
    .where(eq(accounts.id, item.accountId))
    .limit(1);

  if (!account?.typefullySocialSetId) {
    helpers.logger.warn(
      `[typefully] item ${productionItemId} account=${item.accountId} has no typefullySocialSetId — skip`,
    );
    return;
  }

  const draft = await createTypefullyDraft({
    socialSetId: account.typefullySocialSetId,
    platform: item.postType as TypefullyPlatform,
    text,
    draftTitle: item.title ?? undefined,
  });

  await db
    .update(productionItems)
    .set({
      typefullyDraftId: draft.id,
      typefullyStatus: draft.status,
      typefullyShareUrl: draft.share_url,
      typefullyPrivateUrl: draft.private_url,
      typefullyScheduledDate: draft.scheduled_date
        ? new Date(draft.scheduled_date)
        : null,
      typefullyPublishedAt: draft.published_at
        ? new Date(draft.published_at)
        : null,
      typefullyError: null,
    })
    .where(eq(productionItems.id, productionItemId));

  // Surface the completion in the activity feed. private_url is the
  // editable Typefully draft URL; share_url is the public preview.
  // Prefer private — that's the link an operator wants to click.
  await recordToolAction({
    contentItemId: productionItemId,
    userId: item.editorUserId ?? null,
    tool: "typefully",
    action: "draft_created",
    status: "success",
    label: "Draft created in Typefully",
    url: draft.private_url ?? draft.share_url ?? null,
    meta: { platform: item.postType, draftStatus: draft.status },
  });

  helpers.logger.info(
    `[typefully] item ${productionItemId} draft=${draft.id} status=${draft.status}`,
  );
};
