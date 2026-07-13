/**
 * Cutover script: create a Feedhook (feedhook.walls.sh) subscription for every
 * active account on a Feedhook-capable platform, pointing at the
 * /api/webhooks/feedhook receiver, and stamp `accounts.feedhook_subscription_id`.
 *
 * Platforms:
 *   youtube            → WebSub push subscription ({channel: UC… id or @handle})
 *   x, instagram,      → polled profile-feed subscription ({url: profile URL},
 *   tiktok               Feedhook polls Pulse /content every ~10 min)
 *
 * Every subscription supplies the SAME signing secret (FEEDHOOK_WEBHOOK_SECRET)
 * so the receiver verifies the whole fleet with one env var. Idempotent:
 * accounts with feedhook_subscription_id already set are skipped, and
 * Feedhook's POST /subscriptions is itself idempotent per (feed, callback).
 *
 * Usage:
 *   heroku run --app=hubandspoke -- node scripts/feedhook-subscribe.mjs            # dry-run
 *   heroku run --app=hubandspoke -- node scripts/feedhook-subscribe.mjs --apply    # create + stamp
 *
 * Flags:
 *   --apply             actually create subscriptions (default: dry-run)
 *   --platform=x        limit to one platform
 *   --unsubscribe       DELETE the subscriptions instead (rollback) + null the column
 *
 * Env:
 *   FEEDHOOK_API_KEY         fh_… key (account should be on the internal plan —
 *                            the fleet is bigger than the pro feed limit)
 *   FEEDHOOK_WEBHOOK_SECRET  shared signing secret (16–128 chars; same value
 *                            must be set on the Heroku app for the receiver)
 *   FEEDHOOK_BASE            optional, default https://feedhook.walls.sh
 *   FEEDHOOK_CALLBACK_URL    optional, default
 *                            https://hubandspoke.starterstory.com/api/webhooks/feedhook
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const UNSUBSCRIBE = args.includes("--unsubscribe");
const ONLY_PLATFORM = args.find((a) => a.startsWith("--platform="))?.split("=")[1] ?? null;

const FEEDHOOK_BASE = (process.env.FEEDHOOK_BASE || "https://feedhook.walls.sh").replace(/\/$/, "");
const CALLBACK_URL =
  process.env.FEEDHOOK_CALLBACK_URL ||
  "https://hubandspoke.starterstory.com/api/webhooks/feedhook";
const API_KEY = process.env.FEEDHOOK_API_KEY;
const SECRET = process.env.FEEDHOOK_WEBHOOK_SECRET;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (APPLY && (!API_KEY || !SECRET)) {
  console.error("--apply needs FEEDHOOK_API_KEY and FEEDHOOK_WEBHOOK_SECRET");
  process.exit(1);
}

const SUPPORTED = new Set(["youtube", "x", "instagram", "tiktok"]);

// The feed Feedhook should watch, per account. YouTube prefers the stable
// channel id (external_id) over the mutable handle.
function feedBody(account) {
  if (account.platform === "youtube") {
    return { channel: account.external_id || `@${account.handle}` };
  }
  const profileUrl =
    account.platform === "x"
      ? `https://x.com/${account.handle}`
      : account.platform === "instagram"
        ? `https://www.instagram.com/${account.handle}`
        : `https://www.tiktok.com/@${account.handle}`;
  return { url: profileUrl };
}

async function feedhook(method, path, body) {
  const res = await fetch(`${FEEDHOOK_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 2,
  ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
});

const rows = await sql`
  SELECT id, platform, handle, external_id, feedhook_subscription_id
  FROM accounts
  WHERE deleted_at IS NULL
    AND is_active = true
    AND platform = ANY(${[...SUPPORTED]})
    ${ONLY_PLATFORM ? sql`AND platform = ${ONLY_PLATFORM}` : sql``}
  ORDER BY platform, handle
`;

console.log(`${rows.length} active account(s) on Feedhook-capable platforms`);
let created = 0, skipped = 0, removed = 0, failed = 0;

for (const account of rows) {
  const label = `${account.platform}/@${account.handle}`;

  if (UNSUBSCRIBE) {
    if (!account.feedhook_subscription_id) { skipped++; continue; }
    if (!APPLY) { console.log(`[dry-run] would UNSUBSCRIBE ${label} (${account.feedhook_subscription_id})`); continue; }
    const { status } = await feedhook("DELETE", `/subscriptions/${account.feedhook_subscription_id}`);
    if (status === 200 || status === 404) {
      await sql`UPDATE accounts SET feedhook_subscription_id = NULL, updated_at = now() WHERE id = ${account.id}`;
      console.log(`✓ unsubscribed ${label}`);
      removed++;
    } else {
      console.error(`✗ ${label}: DELETE returned ${status}`);
      failed++;
    }
    continue;
  }

  if (account.feedhook_subscription_id) {
    console.log(`= ${label} already subscribed (${account.feedhook_subscription_id})`);
    skipped++;
    continue;
  }
  const body = { ...feedBody(account), callbackUrl: CALLBACK_URL, secret: SECRET };
  if (!APPLY) {
    console.log(`[dry-run] would subscribe ${label} → ${JSON.stringify(feedBody(account))}`);
    continue;
  }
  const { status, json } = await feedhook("POST", "/subscriptions", body);
  if ((status === 201 || status === 200) && json.id) {
    await sql`UPDATE accounts SET feedhook_subscription_id = ${json.id}, updated_at = now() WHERE id = ${account.id}`;
    console.log(`✓ subscribed ${label} → ${json.id} (${json.platform || "youtube"}, state=${json.state})`);
    created++;
  } else {
    console.error(`✗ ${label}: ${status} ${JSON.stringify(json).slice(0, 200)}`);
    failed++;
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.log(
  UNSUBSCRIBE
    ? `done: ${removed} unsubscribed, ${skipped} without subscription, ${failed} failed`
    : `done: ${created} created, ${skipped} already subscribed, ${failed} failed${APPLY ? "" : " (dry-run — pass --apply)"}`
);
await sql.end();
