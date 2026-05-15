import type { Task } from "graphile-worker";
import { syncKlaviyoCampaigns } from "@/lib/services/klaviyo-sync";
import { enqueue } from "@/jobs/enqueue";

export interface KlaviyoSyncAccountPayload {
  accountId: string;
  /** Earliest send_time to fetch (ISO string). Defaults inside the service
   *  to `accounts.lastContentSyncAt` or 7 days ago. */
  sinceIso?: string;
  /** Latest send_time to fetch, exclusive (ISO string). Defaults to now. */
  untilIso?: string;
  /** When true, enqueue per-item enrich + metrics jobs for newly inserted
   *  rows so the data lands without waiting for the next sweep tick.
   *  Defaults to true; the backfill script overrides the same way. */
  enqueueDownstream?: boolean;
}

/**
 * Per-account Klaviyo sync. Discovers Sent campaigns on the account's list
 * and upserts them as newsletter production_items. Enqueues per-item
 * enrich-item + refresh-item-metrics for newly inserted rows so subject /
 * body / opens land within minutes instead of waiting on the next sweep tick.
 */
export const klaviyoSyncAccountTask: Task = async (rawPayload, helpers) => {
  const payload = (rawPayload ?? {}) as KlaviyoSyncAccountPayload;
  const { accountId } = payload;
  if (!accountId) {
    throw new Error("klaviyo-sync-account: accountId is required");
  }
  const start = Date.now();
  helpers.logger.info(`klaviyo-sync-account start account=${accountId}`);

  const since = payload.sinceIso ? new Date(payload.sinceIso) : undefined;
  const until = payload.untilIso ? new Date(payload.untilIso) : undefined;
  const result = await syncKlaviyoCampaigns(accountId, { since, until });

  helpers.logger.info(
    `klaviyo-sync-account ok account=${accountId} fetched=${result.fetched} created=${result.created} updated=${result.updated} skipped=${result.skipped} pages=${result.pagesFetched} errors=${result.errors} (${Date.now() - start}ms)`,
  );

  if (payload.enqueueDownstream !== false && result.insertedItemIds.length > 0) {
    for (const id of result.insertedItemIds) {
      await enqueue("enrich-item", { productionItemId: id });
      await enqueue("refresh-item-metrics", { productionItemId: id });
    }
    helpers.logger.info(
      `klaviyo-sync-account enqueued ${result.insertedItemIds.length} enrich+metrics pairs`,
    );
  }

  if (result.errorMessage) {
    // Re-throw so graphile-worker logs + retries — the service already
    // stamped lastContentSyncError on the account row.
    throw new Error(result.errorMessage);
  }
};
