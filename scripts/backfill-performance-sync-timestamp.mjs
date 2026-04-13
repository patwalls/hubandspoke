/**
 * One-time backfill: sets lastPerformanceSyncAt = updatedAt on all MATG items.
 *
 * This prevents the decay schedule from trying to sync everything on first run.
 * Run once after deploying the performance decay feature.
 *
 * Usage: node scripts/backfill-performance-sync-timestamp.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { eq, isNull, and, sql } from 'drizzle-orm';

const productionItems = pgTable("production_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  brand: text("brand").default("starter-story").notNull(),
  lastPerformanceSyncAt: timestamp("last_performance_sync_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client);

// Set lastPerformanceSyncAt = updatedAt where it's currently null
const result = await db.update(productionItems)
  .set({ lastPerformanceSyncAt: sql`updated_at` })
  .where(and(
    eq(productionItems.brand, 'matg'),
    isNull(productionItems.lastPerformanceSyncAt)
  ))
  .returning({ id: productionItems.id });

console.log(`✅ Backfilled lastPerformanceSyncAt on ${result.length} MATG items`);
await client.end();
