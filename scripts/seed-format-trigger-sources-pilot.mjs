/**
 * Pilot seed: futurepedia_io YouTube → Full Video on X
 *
 * Inserts the first format_trigger_sources row for the account-based
 * Triggered queue routing. Idempotent — uses ON CONFLICT DO NOTHING.
 *
 * Run:
 *   node --env-file=.env.local scripts/seed-format-trigger-sources-pilot.mjs
 *
 * Before deploying the new threshold-monitor-sweep, also set:
 *   heroku config:set TRIGGER_ROUTING_MIN_PUBLISHED_AT=<7-days-ago-iso> --app hubandspoke
 */

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
  max: 1,
});

// Look up by natural keys so this script works across any DB copy.
const [account] = await sql`
  SELECT id, handle, display_name
  FROM accounts
  WHERE handle = 'futurepedia_io'
    AND platform = 'youtube'
    AND deleted_at IS NULL
`;
if (!account) {
  console.error("ERROR: futurepedia_io YouTube account not found.");
  process.exit(1);
}

// "Full Video on X" that is a child of "Youtube Episode" (Futurepedia's
// pillar format). There is a same-named format under "Podcast Episode" (MATG)
// — the parent name join ensures we pick the right one.
const [format] = await sql`
  SELECT f.id, f.name, f.view_threshold, p.name AS parent_name
  FROM formats f
  JOIN formats p ON p.id = f.parent_format_id
  WHERE f.name = 'Full Video on X'
    AND p.name = 'Youtube Episode'
`;
if (!format) {
  console.error(
    "ERROR: 'Full Video on X' (child of 'Youtube Episode') format not found."
  );
  process.exit(1);
}

console.log(`Account : ${account.handle} (${account.display_name}) — ${account.id}`);
console.log(
  `Format  : ${format.name} (parent: ${format.parent_name}, view_threshold: ${format.view_threshold}) — ${format.id}`
);

const [inserted] = await sql`
  INSERT INTO format_trigger_sources (format_id, source_account_id)
  VALUES (${format.id}, ${account.id})
  ON CONFLICT (format_id, source_account_id) DO NOTHING
  RETURNING id
`;

if (inserted) {
  console.log(`\nInserted format_trigger_sources row: ${inserted.id}`);
} else {
  console.log("\nRow already exists — no change (idempotent).");
}

await sql.end();
