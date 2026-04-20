// One-time bootstrap for an existing DB that predates drizzle-kit migrations.
// Creates drizzle's bookkeeping schema and marks every migration in
// drizzle/meta/_journal.json as already applied — without running their SQL.
// After this, `drizzle-kit migrate` will only run NEW migrations on top.
// Safe to re-run: skips any hash already recorded.
import postgres from "postgres";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };

const sql = postgres(url, { prepare: false, ssl });

const MIGRATIONS_DIR = "drizzle";

try {
  await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

  let inserted = 0;
  let skipped = 0;
  for (const entry of journal.entries) {
    const migrationPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    const migrationSql = fs.readFileSync(migrationPath, "utf8");
    const hash = crypto
      .createHash("sha256")
      .update(migrationSql)
      .digest("hex");

    const existing = await sql`
      SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = ${hash} LIMIT 1
    `;
    if (existing.length > 0) {
      skipped++;
      console.log(`  skip  ${entry.tag}  (hash already recorded)`);
      continue;
    }

    await sql`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `;
    inserted++;
    console.log(`  mark  ${entry.tag}  (hash=${hash.slice(0, 12)}…)`);
  }

  console.log(
    `\nBootstrap complete: ${inserted} marked as applied, ${skipped} already present.`
  );
} catch (err) {
  console.error("Error:", err);
  process.exit(1);
} finally {
  await sql.end();
}
