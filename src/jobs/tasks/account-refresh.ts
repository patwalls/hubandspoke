import type { Task } from "graphile-worker";
import { refreshAccount } from "@/lib/services/account-refresh";

export interface AccountRefreshPayload {
  accountId: string;
}

/**
 * Pulls account-level metadata from Scrape Creators (follower count,
 * avatar, bio, …) for one `accounts` row and writes the result back.
 *
 * Idempotent — each run simply overwrites the fields SC returned. Errors
 * bubble up to graphile-worker for retry with exponential backoff; the
 * service layer also stamps `last_refresh_error` so the settings UI can
 * surface recent failures without waiting for a log scrape.
 *
 * Enqueued from:
 *   - The settings page "Refresh" button (on-demand)
 *   - A weekly crontab entry that fans out one job per active account
 */
export const accountRefreshTask: Task = async (rawPayload, helpers) => {
  const { accountId } = rawPayload as AccountRefreshPayload;
  if (!accountId) throw new Error("account-refresh: missing accountId");
  helpers.logger.info(`account-refresh start account=${accountId}`);
  await refreshAccount(accountId);
  helpers.logger.info(`account-refresh ok account=${accountId}`);
};
