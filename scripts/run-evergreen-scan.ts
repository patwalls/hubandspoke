// One-off runner to verify the evergreen scan works before the daily cron
// kicks in. Safe to re-run — the scan itself is idempotent (capped at 5
// pending suggestions, skips items with a repost in the last 30 days).
import { runEvergreenScan } from "../src/lib/services/evergreen-scan";

async function main() {
  const start = Date.now();
  const result = await runEvergreenScan();
  console.log(`[evergreen-scan] ${Date.now() - start}ms`);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[evergreen-scan] failed:", err);
    process.exit(1);
  });
