/**
 * One-shot backfill (2026-10-23, Pat's call): unassign every open Idea in
 * Pat's name. They got him through the old resolveEditor fallback and clip
 * ideas inheriting a Pat-owned pillar — ~2,242 Ideas he never worked on.
 * New ideas already start unassigned (clip-idea-item-values.ts).
 *
 * Sets editor_user_id = NULL on production_items with status 'Idea', not
 * deleted, editor = Pat, and writes one `editor_change` content_event per item
 * (actor Pat, "Pat Walls → none") so the activity feed shows what happened.
 * One transaction. Re-running is a no-op (nothing left to match).
 *
 * Usage:
 *   heroku run --app=hubandspoke -- node scripts/backfill-unassign-pat-ideas.mjs           # dry-run
 *   heroku run --app=hubandspoke -- node scripts/backfill-unassign-pat-ideas.mjs --apply   # commit
 */
import postgres from "postgres";

const apply = process.argv.includes("--apply");
const PAT_EMAIL = "patrickswalls@gmail.com";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const sql = postgres(databaseUrl, {
  max: 1,
  ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
});

try {
  const [pat] = await sql`SELECT id, name, email FROM users WHERE lower(email) = ${PAT_EMAIL}`;
  if (!pat) throw new Error(`${PAT_EMAIL} not found`);
  const patName = pat.name?.trim() || pat.email.split("@")[0];

  const byBrand = await sql`
    SELECT brand, count(*)::int AS n FROM production_items
    WHERE editor_user_id = ${pat.id} AND status = 'Idea' AND deleted_at IS NULL
    GROUP BY brand ORDER BY n DESC`;
  const total = byBrand.reduce((t, r) => t + r.n, 0);
  console.log(`Open Ideas in ${patName}'s name: ${total}`);
  for (const r of byBrand) console.log(`  ${r.brand.padEnd(22)} ${r.n}`);

  if (!apply) {
    console.log("\nDry run — nothing changed. Re-run with --apply.");
  } else {
    const changed = await sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE production_items SET editor_user_id = NULL
        WHERE editor_user_id = ${pat.id} AND status = 'Idea' AND deleted_at IS NULL
        RETURNING id`;
      if (rows.length) {
        await tx`
          INSERT INTO content_events (content_item_id, user_id, event_type, payload)
          SELECT id, ${pat.id}::uuid, 'editor_change',
            jsonb_build_object('type', 'editor_change', 'from', ${patName}::text, 'to', NULL)
          FROM unnest(${tx.array(rows.map((r) => r.id))}::uuid[]) AS id`;
      }
      return rows.length;
    });
    console.log(`\nUnassigned ${changed} Ideas.`);
  }
} finally {
  await sql.end();
}
