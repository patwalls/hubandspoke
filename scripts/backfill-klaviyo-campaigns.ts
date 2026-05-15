/**
 * One-shot 12-month backfill of Klaviyo campaigns for one (or all)
 * newsletter account(s). Idempotent — re-runs upsert by
 * (account_id, platform_content_id), so re-running is harmless and
 * useful when extending the window.
 *
 * For each newly inserted production_items row, enqueues an
 * `enrich-item` (body + preview text + from-name) and a
 * `refresh-item-metrics` (opens / clicks / recipients) so the data
 * lands without waiting on the next sweep tick.
 *
 * Usage (local — must have KLAVIYO_API_KEY in .env.local):
 *   npx tsx --env-file=.env.local scripts/backfill-klaviyo-campaigns.ts
 *   npx tsx --env-file=.env.local scripts/backfill-klaviyo-campaigns.ts --account-id <uuid>
 *   npx tsx --env-file=.env.local scripts/backfill-klaviyo-campaigns.ts --since 2025-01-01
 *
 * Usage (prod):
 *   heroku run --app=hubandspoke -- bash -lc "npx tsx scripts/backfill-klaviyo-campaigns.ts"
 */
import { syncKlaviyoCampaigns, selectNewsletterAccountsForSync } from "../src/lib/services/klaviyo-sync";
import { enqueue } from "../src/jobs/enqueue";
import { workerUtilsEnd } from "../src/jobs/enqueue";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

const accountIdArg = flag("account-id");
const sinceArg = flag("since");
const untilArg = flag("until");

const since = sinceArg
  ? new Date(sinceArg)
  : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
const until = untilArg ? new Date(untilArg) : new Date();

if (Number.isNaN(since.getTime())) {
  console.error(`Invalid --since: ${sinceArg}`);
  process.exit(1);
}
if (Number.isNaN(until.getTime())) {
  console.error(`Invalid --until: ${untilArg}`);
  process.exit(1);
}

async function main() {
  const accounts = accountIdArg
    ? [{ id: accountIdArg, handle: "(specified)", externalId: "(specified)" }]
    : await selectNewsletterAccountsForSync();

  if (accounts.length === 0) {
    console.log("No newsletter accounts found. Run scripts/seed-newsletter-account.mjs first.");
    return;
  }

  console.log(
    `Backfilling ${accounts.length} account(s) from ${since.toISOString()} to ${until.toISOString()}`,
  );

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const acct of accounts) {
    console.log(`\n── account ${acct.id} (${acct.handle}, list=${acct.externalId})`);
    const start = Date.now();
    const result = await syncKlaviyoCampaigns(acct.id, { since, until });
    console.log(
      `   fetched=${result.fetched} created=${result.created} updated=${result.updated} skipped=${result.skipped} pages=${result.pagesFetched} errors=${result.errors} (${Date.now() - start}ms)`,
    );
    if (result.errorMessage) {
      console.error(`   error: ${result.errorMessage}`);
    }
    for (const itemId of result.insertedItemIds) {
      await enqueue("enrich-item", { productionItemId: itemId });
      await enqueue("refresh-item-metrics", { productionItemId: itemId });
    }
    if (result.insertedItemIds.length > 0) {
      console.log(`   enqueued ${result.insertedItemIds.length} enrich + metrics pairs`);
    }
    totalCreated += result.created;
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
  }

  console.log(
    `\nDone. created=${totalCreated} updated=${totalUpdated} skipped=${totalSkipped} errors=${totalErrors}`,
  );
}

main()
  .then(async () => {
    await workerUtilsEnd();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("backfill failed:", err);
    await workerUtilsEnd();
    process.exit(1);
  });
