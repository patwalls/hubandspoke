// Backfill existing MATG videos with "Business Interview" format
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { pgTable, uuid, text, date, boolean, integer, decimal, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { eq, isNull, and } from 'drizzle-orm';

const productionItems = pgTable("production_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  brand: text("brand").default("starter-story").notNull(),
  format: text("format"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client);

const result = await db.update(productionItems)
  .set({ format: 'Business Interview', updatedAt: new Date() })
  .where(and(
    eq(productionItems.brand, 'matg'),
    isNull(productionItems.format)
  ))
  .returning({ id: productionItems.id });

console.log(`Updated ${result.length} MATG items with "Business Interview" format`);
await client.end();
