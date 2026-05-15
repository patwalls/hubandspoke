import type { Task } from "graphile-worker";
import { selectNewsletterAccountsForSync } from "@/lib/services/klaviyo-sync";
import type { KlaviyoSyncAccountPayload } from "./klaviyo-sync-account";

/**
 * Cron parent: fan out one `klaviyo-sync-account` per active newsletter
 * account that has a Klaviyo list id (`accounts.external_id`). Mirrors the
 * shape of `account-content-sync-sweep` for SC platforms. Per-account
 * dedup via `jobKey` so overlapping ticks don't double-fire.
 */
export const klaviyoSyncSweepTask: Task = async (_payload, helpers) => {
  const start = Date.now();
  helpers.logger.info("klaviyo-sync-sweep start");
  const rows = await selectNewsletterAccountsForSync();
  for (const row of rows) {
    const payload: KlaviyoSyncAccountPayload = { accountId: row.id };
    await helpers.addJob("klaviyo-sync-account", payload as never, {
      jobKey: `klaviyo-sync-account-${row.id}`,
      jobKeyMode: "unsafe_dedupe",
    });
  }
  helpers.logger.info(
    `klaviyo-sync-sweep fanned out ${rows.length} accounts (${Date.now() - start}ms)`,
  );
};
