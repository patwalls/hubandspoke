import type { Task } from "graphile-worker";
import { reconcileTikTokPublish } from "@/lib/services/tiktok-draft/send";

export interface ZernioPollPublishPayload {
  productionItemId: string;
  /** Epoch ms — stop polling after this. */
  deadlineAt?: number;
}

const POLL_INTERVAL_MS = 10_000;
const DEADLINE_MS = 5 * 60 * 1000;

/**
 * Worker fallback for the async direct-publish flow: poll Zernio until a
 * `publishing` item settles (Published / failed). The content page's banner
 * already drives this client-side via /tiktok-status while the user watches —
 * this covers the closed-tab case in prod (the worker dyno runs it). Both call
 * the same idempotent `reconcileTikTokPublish`, so a double-fire is harmless.
 *
 * Self-re-enqueues every 10s (Descript pattern) until settled or the deadline.
 */
export const zernioPollPublishTask: Task = async (rawPayload, helpers) => {
  const { productionItemId, deadlineAt } =
    rawPayload as ZernioPollPublishPayload;

  const pastDeadline = Date.now() >= (deadlineAt ?? Date.now() + DEADLINE_MS);

  // At the deadline, force-settle even a live-but-linkless post so it can't
  // poll forever (it becomes Published without a link; the metrics/content
  // sync can backfill the URL later).
  const result = await reconcileTikTokPublish(productionItemId, null, {
    finalizeWithoutLink: pastDeadline,
  });
  if (result.settled) {
    helpers.logger.info(
      `[zernio-poll] item ${productionItemId} settled → ${result.zernioStatus}`,
    );
    return;
  }

  if (pastDeadline) {
    helpers.logger.warn(
      `[zernio-poll] item ${productionItemId} still publishing at deadline`,
    );
    return;
  }

  await helpers.addJob(
    "zernio-poll-publish",
    { productionItemId, deadlineAt: deadlineAt ?? Date.now() + DEADLINE_MS },
    { runAt: new Date(Date.now() + POLL_INTERVAL_MS) },
  );
};
