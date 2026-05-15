/**
 * Idempotent seed: insert (or refresh) a newsletter account row for the
 * Starter Story Klaviyo list.
 *
 * Usage (local):
 *   node --env-file=.env.local scripts/seed-newsletter-account.mjs
 *
 * Usage (Heroku):
 *   heroku run --app=hubandspoke node scripts/seed-newsletter-account.mjs
 *
 * Re-running just touches `updated_at` — it never duplicates.
 */
import postgres from "postgres";

const BRAND_SLUG = "starter-story";
const HANDLE = "starter-story-newsletter";
// `WrZnKM` is the "Newsletter Segment" — derived from the main "Starter
// Story" list (`KBDbDN`) by recent open/click activity. It's the actual
// audience Sunday Breakfast goes to. The bare list id was the wrong
// target — campaigns are sent to this segment, not the raw list.
const KLAVIYO_LIST_ID = "WrZnKM";
const URL = "https://www.starterstory.com/";
const DISPLAY_NAME = "Starter Story Newsletter";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(databaseUrl, {
  ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
  max: 2,
});

async function main() {
  const [brand] = await sql`SELECT id, slug FROM brands WHERE slug = ${BRAND_SLUG} LIMIT 1`;
  if (!brand) {
    console.error(`Brand "${BRAND_SLUG}" not found — seed brands first.`);
    process.exit(1);
  }

  const [existing] = await sql`
    SELECT id, handle, external_id, display_name
      FROM accounts
     WHERE platform = 'newsletter' AND lower(handle) = lower(${HANDLE})
     LIMIT 1
  `;

  if (existing) {
    await sql`
      UPDATE accounts
         SET external_id = ${KLAVIYO_LIST_ID},
             display_name = ${DISPLAY_NAME},
             url = ${URL},
             is_active = true,
             updated_at = now()
       WHERE id = ${existing.id}
    `;
    console.log(`Refreshed existing newsletter account ${existing.id}`);
    console.log(`   handle:      ${HANDLE}`);
    console.log(`   external_id: ${KLAVIYO_LIST_ID}`);
  } else {
    const [inserted] = await sql`
      INSERT INTO accounts (
        brand_id, platform, handle, display_name, url, external_id, is_active
      ) VALUES (
        ${brand.id}, 'newsletter', ${HANDLE}, ${DISPLAY_NAME}, ${URL},
        ${KLAVIYO_LIST_ID}, true
      )
      RETURNING id
    `;
    console.log(`Created newsletter account ${inserted.id}`);
    console.log(`   brand:       ${BRAND_SLUG}`);
    console.log(`   handle:      ${HANDLE}`);
    console.log(`   external_id: ${KLAVIYO_LIST_ID}`);
  }

  await sql.end();
}

main().catch(async (err) => {
  console.error("seed-newsletter-account failed:", err);
  await sql.end();
  process.exit(1);
});
