/**
 * Backfill: archive every account's avatar to S3 (see
 * src/lib/services/account-avatar.ts). Accounts whose platform URL has
 * already expired can't be archived from here — those get an
 * `account-refresh` job enqueued, which fetches a fresh URL and archives it.
 *
 *   npx tsx scripts/backfill-account-avatars.ts            (dry run)
 *   npx tsx scripts/backfill-account-avatars.ts --apply
 */
import { isNotNull } from "drizzle-orm";

const apply = process.argv.includes("--apply");

async function main() {
  const { db } = await import("../src/lib/db");
  const { accounts } = await import("../src/lib/db/schema");
  const { archiveAccountAvatar, isProxiedAvatar } = await import("../src/lib/services/account-avatar");
  const { enqueue } = await import("../src/jobs/enqueue");
  const rows = await db.select({ id: accounts.id, platform: accounts.platform, handle: accounts.handle, avatarUrl: accounts.avatarUrl }).from(accounts).where(isNotNull(accounts.avatarUrl));
  const todo = rows.filter((r) => !isProxiedAvatar(r.avatarUrl));
  console.log(`${rows.length} accounts with an avatar, ${todo.length} not yet archived.`);
  if (!apply) return console.log("Dry run — add --apply.");
  let archived = 0;
  let refreshQueued = 0;
  for (const r of todo) {
    const key = await archiveAccountAvatar(r.id, r.avatarUrl);
    if (key) archived++;
    else {
      await enqueue("account-refresh", { accountId: r.id }, { jobKey: `account-refresh:${r.id}`, jobKeyMode: "replace" });
      refreshQueued++;
      console.log(`  ${r.platform} @${r.handle}: expired — refresh queued`);
    }
  }
  console.log(`archived ${archived}, refresh queued for ${refreshQueued}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
