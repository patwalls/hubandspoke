// Replace the legacy "Twitter" platform label on production_items with the
// split "X (Starter Story)" / "X (Pat Walls)" labels that replaced it. The
// rename happened on the constants side a while back but ~1.4k historical rows
// still carry "Twitter", so they show up as a phantom row in the Production
// report.
//
// Classification:
//   1. published_link points at x.com/starter_story or twitter.com/starter_story
//      → "X (Starter Story)"
//   2. published_link points at x.com/thepatwalls or twitter.com/thepatwalls
//      → "X (Pat Walls)"
//   3. published_link points at starterstory.com (SS brand promoting articles)
//      → "X (Starter Story)"
//   4. Anything else (external X handle quote, loom/typefully link, no link)
//      → "X (Starter Story)" as the default for SS brand
//
// If the target platform is already present on the row, "Twitter" is simply
// removed. Otherwise "Twitter" is replaced in-place so platform order is
// preserved.
//
// Usage:
//   node --env-file=.env.local scripts/backfill-twitter-to-x.mjs [--apply]
//
// Without --apply it prints a dry-run summary and exits.

import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const sql = postgres(url, { ssl, prepare: false });

function classify(link) {
  if (!link) return { target: "X (Starter Story)", bucket: "no-link" };
  const l = link.toLowerCase();
  if (/(?:x|twitter)\.com\/starter_story\b/.test(l)) {
    return { target: "X (Starter Story)", bucket: "ss-handle" };
  }
  if (/(?:x|twitter)\.com\/thepatwalls\b/.test(l)) {
    return { target: "X (Pat Walls)", bucket: "pw-handle" };
  }
  if (/(^|\/\/)(www\.)?starterstory\.com/.test(l)) {
    return { target: "X (Starter Story)", bucket: "ss-article-link" };
  }
  if (/(?:x|twitter)\.com\//.test(l)) {
    return { target: "X (Starter Story)", bucket: "external-x-handle" };
  }
  return { target: "X (Starter Story)", bucket: "other-link" };
}

const rows = await sql`
  SELECT id, platform, published_link
  FROM production_items
  WHERE platform::jsonb ? 'Twitter'
`;

const buckets = new Map();
const updates = [];
for (const r of rows) {
  const { target, bucket } = classify(r.published_link);
  buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  const current = Array.isArray(r.platform) ? r.platform : [];
  const alreadyHasTarget = current.includes(target);
  const next = current
    .map((p) => (p === "Twitter" ? (alreadyHasTarget ? null : target) : p))
    .filter((p) => p !== null);
  updates.push({ id: r.id, next, target, bucket });
}

console.log(`Found ${rows.length} rows with "Twitter" in platform.`);
console.log("By bucket:");
for (const [bucket, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${bucket}: ${count}`);
}

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write.");
  await sql.end();
  process.exit(0);
}

let written = 0;
for (const u of updates) {
  await sql`
    UPDATE production_items
    SET platform = ${sql.json(u.next)}, updated_at = NOW()
    WHERE id = ${u.id}
  `;
  written++;
  if (written % 200 === 0) console.log(`  wrote ${written}/${updates.length}`);
}
console.log(`Done. Wrote ${written} rows.`);

const remaining = await sql`
  SELECT COUNT(*)::int AS n FROM production_items WHERE platform::jsonb ? 'Twitter'
`;
console.log(`Remaining with "Twitter" after backfill: ${remaining[0].n}`);

await sql.end();
