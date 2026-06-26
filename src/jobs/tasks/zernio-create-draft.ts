import type { Task } from "graphile-worker";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  sendTikTokDraft,
  TikTokDraftError,
} from "@/lib/services/tiktok-draft/send";

export interface ZernioCreateDraftPayload {
  productionItemId: string;
  /** TikTok privacy level chosen at schedule time. */
  privacyLevel?: string;
}

/**
 * Fire a scheduled TikTok draft send. Enqueued by the tiktok-draft route's
 * `schedule` mode with `runAt` set to the operator's chosen go-live time and
 * `jobKey: zernio:<id>` (jobKeyMode 'replace', so reschedule never leaves a
 * second job).
 *
 * Race-guard (mirrors descript-publish-and-archive): re-read the row at fire
 * time. The send was scheduled by flipping `zernioStatus='scheduled'`, so:
 *  - already delivered (zernioPostId set) → soft-skip (idempotent).
 *  - zernioStatus !== 'scheduled' → the schedule was cancelled or superseded
 *    (cancel clears the column; a re-schedule replaced the job) → bail.
 * Otherwise call the shared sender, which re-validates every guardrail against
 * a fresh read and mints the presigned URL at the last moment.
 *
 * The sender throws TikTokDraftError on a hard block (e.g. the video was
 * removed between scheduling and firing) — we swallow it after the sender has
 * stamped zernioError, since retrying a guardrail block can't succeed. A
 * Zernio API error re-throws so graphile-worker retries with backoff.
 */
export const zernioCreateDraftTask: Task = async (rawPayload, helpers) => {
  const { productionItemId, privacyLevel } =
    rawPayload as ZernioCreateDraftPayload;

  const [item] = await db
    .select({
      id: productionItems.id,
      zernioPostId: productionItems.zernioPostId,
      zernioStatus: productionItems.zernioStatus,
      editorUserId: productionItems.editorUserId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    helpers.logger.warn(
      `[zernio] scheduled item ${productionItemId} not found — skip`,
    );
    return;
  }
  if (item.zernioPostId) {
    helpers.logger.info(
      `[zernio] item ${productionItemId} already delivered (${item.zernioPostId}) — skip`,
    );
    return;
  }
  if (item.zernioStatus !== "scheduled") {
    helpers.logger.info(
      `[zernio] item ${productionItemId} status=${item.zernioStatus ?? "null"} (not scheduled) — cancelled/superseded, bailing`,
    );
    return;
  }

  try {
    const result = await sendTikTokDraft(productionItemId, {
      actorUserId: item.editorUserId ?? null,
      fromScheduledTask: true,
      privacyLevel,
    });
    helpers.logger.info(
      `[zernio] item ${productionItemId} published=${result.published} post=${result.zernioPostId}`,
    );
  } catch (err) {
    if (err instanceof TikTokDraftError) {
      // Hard guardrail block — retrying can't succeed. The sender already
      // stamped zernioError; log and stop.
      helpers.logger.warn(
        `[zernio] item ${productionItemId} blocked: ${err.block.code} — ${err.block.message}`,
      );
      return;
    }
    // Zernio API / network error — rethrow so graphile-worker retries.
    throw err;
  }
};
