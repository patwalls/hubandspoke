/**
 * One-time backfill: promote the founding admins to role=admin.
 *
 * Usage: heroku run --app=hubandspoke node scripts/backfill-seed-admins.mjs
 *        (or locally: node scripts/backfill-seed-admins.mjs)
 *
 * Idempotent — re-running is a no-op for users who are already admins.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
import { inArray } from 'drizzle-orm';

const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("creator"),
});

const ADMIN_EMAILS = [
  'patrickswalls@gmail.com',
  'sam@starterstory.com',
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client);

const result = await db.update(users)
  .set({ role: 'admin' })
  .where(inArray(users.email, ADMIN_EMAILS))
  .returning({ id: users.id, email: users.email, role: users.role });

if (result.length === 0) {
  console.warn(`⚠️  No users matched ${ADMIN_EMAILS.join(', ')} — check the emails exist in the users table.`);
} else {
  for (const row of result) {
    console.log(`✅ ${row.email} → ${row.role}`);
  }
  const missing = ADMIN_EMAILS.filter((e) => !result.some((r) => r.email === e));
  if (missing.length) {
    console.warn(`⚠️  Not found in users table: ${missing.join(', ')}`);
  }
}

await client.end();
