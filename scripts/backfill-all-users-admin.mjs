/**
 * One-shot backfill for the brand-permissions launch (2026-10-28): promote
 * every existing `creator` to `admin`, so nobody loses edit access when
 * creators become view-only on brands not in their `users.brand_ids`
 * (src/lib/brand-access.ts). Admins then demote people back to creator one by
 * one in Settings → Users.
 *
 * Run it BEFORE the permissions deploy goes live. Prints every promoted email
 * — keep the output: it's the list to restore from if this needs undoing.
 * Re-running is a no-op once nobody is a creator.
 *
 * Usage:
 *   heroku run --app=hubandspoke -- node scripts/backfill-all-users-admin.mjs            # dry-run
 *   heroku run --app=hubandspoke -- node scripts/backfill-all-users-admin.mjs --apply    # commit
 */
import postgres from "postgres";

const apply = process.argv.slice(2).includes("--apply");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const isLocal = databaseUrl.includes("localhost");
const sql = postgres(databaseUrl, {
  ssl: isLocal ? false : "require",
  max: 2,
});

try {
  const creators = await sql`
    select email from users where role = 'creator' order by email
  `;
  console.log(`${creators.length} creator(s) to promote to admin:`);
  for (const { email } of creators) console.log(`  ${email}`);

  if (!apply) {
    console.log("\nDry run — nothing changed. Re-run with --apply to commit.");
  } else {
    const updated = await sql`
      update users set role = 'admin', updated_at = now()
      where role = 'creator'
      returning email
    `;
    console.log(`\nPromoted ${updated.length} user(s) to admin.`);
  }
} finally {
  await sql.end();
}
