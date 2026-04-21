/**
 * Seed Twitter → Instagram cross-post rules.
 *
 * Inserts two rules that route high-performing Twitter posts into the
 * Instagram Reel and Instagram Post cross-post queues. Threshold is 100k
 * views — higher than the existing Twitter → Threads/LinkedIn rules (25k/50k)
 * because a tweet has to be strong to be worth adapting into a visual format.
 *
 * Idempotent: uses ON CONFLICT DO NOTHING against the uniq_cross_post_rules
 * index on (brand, source_platform, target_platform).
 *
 * Usage:
 *   # dev:
 *   node --env-file=.env.local scripts/seed-crosspost-rules-twitter-to-ig.mjs
 *
 *   # prod:
 *   heroku run --app=hubandspoke \
 *     node scripts/seed-crosspost-rules-twitter-to-ig.mjs
 */
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: connectionString.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 1,
});

const RULES = [
  {
    brand: "starter-story",
    source_platform: "Twitter",
    target_platform: "Instagram Reel",
    view_threshold: 100_000,
  },
  {
    brand: "starter-story",
    source_platform: "Twitter",
    target_platform: "Instagram Post",
    view_threshold: 100_000,
  },
];

async function main() {
  for (const r of RULES) {
    const result = await sql`
      INSERT INTO cross_post_rules
        (brand, source_platform, target_platform, view_threshold, active)
      VALUES
        (${r.brand}, ${r.source_platform}, ${r.target_platform}, ${r.view_threshold}, true)
      ON CONFLICT (brand, source_platform, target_platform) DO NOTHING
      RETURNING id
    `;
    const action = result.length > 0 ? "inserted" : "already exists";
    console.log(
      `${action}: ${r.brand} | ${r.source_platform} ≥ ${r.view_threshold.toLocaleString()} → ${r.target_platform}`
    );
  }
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
