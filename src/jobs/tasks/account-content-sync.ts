import type { Task } from "graphile-worker";
import { syncAccountContent } from "@/lib/services/account-content-sync";

export interface AccountContentSyncPayload {
  accountId: string;
  mode: "latest" | "backfill";
  /** Hard cap on pages fetched. Service defaults to 1 for latest and 50
   *  for backfill — override here when you want a different cost envelope. */
  maxPages?: number;
  /** ISO timestamp — stop walking backfill pages once we pass this moment. */
  sinceIso?: string;
}

/**
 * Per-account content sync. Pulls the creator's timeline from Scrape
 * Creators and upserts each post into `production_items`, keyed on the
 * partial unique index `(account_id, platform_content_id)` so duplicate
 * runs never insert twice.
 *
 * Enqueued from:
 *   - `account-content-sync-sweep` (daily cron, mode=latest)
 *   - POST /api/accounts/[id]/sync-content (manual button)
 *   - POST /api/accounts (new-account auto-backfill)
 */
export const accountContentSyncTask: Task = async (rawPayload, helpers) => {
  const { accountId, mode, maxPages, sinceIso } =
    rawPayload as AccountContentSyncPayload;
  if (!accountId) throw new Error("account-content-sync: missing accountId");
  helpers.logger.info(
    `account-content-sync start account=${accountId} mode=${mode} maxPages=${
      maxPages ?? "default"
    }`
  );
  const result = await syncAccountContent(accountId, {
    mode,
    maxPages,
    since: sinceIso ? new Date(sinceIso) : undefined,
  });
  helpers.logger.info(
    `account-content-sync ok account=${accountId} platform=${result.platform} fetched=${result.fetched} created=${result.created} updated=${result.updated} errors=${result.errors} credits=${result.creditsUsed}`
  );
  if (result.errorMessage) {
    // Surface as a task failure so graphile-worker retries with backoff.
    throw new Error(result.errorMessage);
  }
};
