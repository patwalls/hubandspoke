/**
 * One-time backfill: generate a unique CTA UTM campaign slug for every
 * production_items row whose utm_campaign is still NULL.
 *
 * Slug shape: <slugified-first-3-words-of-title>-<3-digit-number>. On collision,
 * retries with a different suffix. The partial unique index on utm_campaign
 * (0022_chubby_sugar_man.sql) still guards correctness — this script just
 * pre-checks to keep retries rare.
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 *
 * Run (dry):   node --env-file=.env.local scripts/backfill-utm-campaign.mjs
 * Run (apply): node --env-file=.env.local scripts/backfill-utm-campaign.mjs --apply
 * Prod apply:  heroku run --app=hubandspoke node scripts/backfill-utm-campaign.mjs --apply
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

console.log(`Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"}`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 4,
});

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

async function pickUniqueSlug(title) {
  const base = slugify(title);
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = Math.floor(Math.random() * 900 + 100);
    const candidate = `${base}-${suffix}`;
    const [{ taken }] = await sql`
      SELECT EXISTS(
        SELECT 1 FROM production_items WHERE utm_campaign = ${candidate}
      ) AS taken
    `;
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

try {
  const [{ total, nulls }] = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE utm_campaign IS NULL)::int AS nulls
    FROM production_items
  `;
  console.log(`Total rows: ${total}  |  NULL utm_campaign: ${nulls}`);

  if (nulls === 0) {
    console.log("Nothing to backfill. Done.");
    await sql.end({ timeout: 5 });
    process.exit(0);
  }

  const rows = await sql`
    SELECT id, title
    FROM production_items
    WHERE utm_campaign IS NULL
    ORDER BY created_at
  `;

  const samples = [];
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    samples.push({
      title: rows[i].title,
      sample: await pickUniqueSlug(rows[i].title),
    });
  }
  console.log("\nSample slugs that would be generated:");
  for (const s of samples) {
    console.log(`  "${s.title?.slice(0, 60) ?? "(null)"}" → ${s.sample}`);
  }

  if (dryRun) {
    console.log("\nDry run — no writes. Re-run with --apply to execute.");
    await sql.end({ timeout: 5 });
    process.exit(0);
  }

  console.log("\nApplying backfill...");
  let updated = 0;
  let conflicts = 0;

  for (const row of rows) {
    const slug = await pickUniqueSlug(row.title);
    try {
      await sql`
        UPDATE production_items
        SET utm_campaign = ${slug}, updated_at = NOW()
        WHERE id = ${row.id} AND utm_campaign IS NULL
      `;
      updated++;
      if (updated % 100 === 0) console.log(`  ${updated}/${rows.length}…`);
    } catch (err) {
      // 23505 = unique_violation: a parallel process or an earlier slug
      // collision that slipped past the pre-check. Retry once with a fresh
      // candidate; if that also fails, skip this row.
      if (err?.code === "23505") {
        conflicts++;
        try {
          const retry = await pickUniqueSlug(row.title);
          await sql`
            UPDATE production_items
            SET utm_campaign = ${retry}, updated_at = NOW()
            WHERE id = ${row.id} AND utm_campaign IS NULL
          `;
          updated++;
        } catch (retryErr) {
          console.error(`  skip ${row.id}: ${retryErr?.message ?? retryErr}`);
        }
      } else {
        throw err;
      }
    }
  }

  console.log(`\nUpdated: ${updated}  |  Conflicts retried: ${conflicts}`);

  const [{ nullsAfter }] = await sql`
    SELECT COUNT(*) FILTER (WHERE utm_campaign IS NULL)::int AS "nullsAfter"
    FROM production_items
  `;
  console.log(`Remaining NULL rows: ${nullsAfter}`);
  if (nullsAfter > 0) {
    console.error("Some rows could not be backfilled. Investigate before reruns.");
    process.exit(1);
  }
  console.log("Done.");
} catch (err) {
  console.error("Backfill failed:", err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
