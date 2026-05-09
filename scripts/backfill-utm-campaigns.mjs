/**
 * Backfill `production_items.utm_campaign` for rows that don't have one.
 *
 * Background: clip-promoted items (sourceType='clip') were inserted by
 * promote-clip-idea + clip-idea-generate without a UTM until the 2026-05-09
 * fix. Notion-synced and API-created items always got one. This one-shot
 * fills in the gap so every item carries a CTA UTM the editor / freelancer
 * can paste into the published link.
 *
 * Idempotent: only touches rows where utm_campaign IS NULL OR ''. Re-running
 * after the fix lands is a no-op.
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 *
 *   node --env-file=.env.local scripts/backfill-utm-campaigns.mjs           # dry
 *   node --env-file=.env.local scripts/backfill-utm-campaigns.mjs --apply   # write
 */
import postgres from "postgres";

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with --env-file=.env.local.");
  process.exit(1);
}
const isHeroku = url.includes("amazonaws.com");
const sql = postgres(url, isHeroku ? { ssl: { rejectUnauthorized: false } } : {});

function slugify(input) {
  const cleaned = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
  return cleaned || "post";
}

async function isTaken(candidate) {
  const rows = await sql`
    SELECT 1 FROM production_items WHERE utm_campaign = ${candidate} LIMIT 1
  `;
  return rows.length > 0;
}

async function pickUtm(title) {
  const base = slugify(title);
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = Math.floor(Math.random() * 900 + 100);
    const candidate = `${base}-${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function main() {
  const missing = await sql`
    SELECT id, title FROM production_items
    WHERE deleted_at IS NULL
      AND (utm_campaign IS NULL OR utm_campaign = '')
    ORDER BY created_at DESC
  `;
  console.log(`Found ${missing.length} items missing utm_campaign.`);
  if (missing.length === 0) {
    await sql.end();
    return;
  }

  let written = 0;
  for (const row of missing) {
    const slug = await pickUtm(row.title);
    if (apply) {
      await sql`UPDATE production_items SET utm_campaign = ${slug} WHERE id = ${row.id}`;
      written++;
      if (written % 100 === 0) console.log(`  …${written}/${missing.length}`);
    } else {
      console.log(`  ${row.id} → ${slug}  (dry-run)`);
    }
  }

  console.log(apply ? `Wrote ${written} utm_campaign values.` : "Dry run — no writes.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
