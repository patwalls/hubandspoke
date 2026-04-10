#!/usr/bin/env node
// Temporary verification script — delete along with the other temp scripts
import postgres from "postgres";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "..", ".env.local") });

const sql = postgres(process.env.DATABASE_URL, { prepare: false });

const total = await sql`SELECT COUNT(*)::int AS c FROM formats`;
const withNotion = await sql`SELECT COUNT(*)::int AS c FROM formats WHERE notion_id IS NOT NULL`;
const withProducer = await sql`SELECT COUNT(*)::int AS c FROM formats WHERE producer_email IS NOT NULL`;
const withViewMin = await sql`SELECT COUNT(*)::int AS c FROM formats WHERE repurpose_view_minimum IS NOT NULL`;
const mappings = await sql`SELECT COUNT(*)::int AS c FROM format_repurpose_mappings`;

console.log("=== Format Import Verification ===");
console.log(`Total formats:                  ${total[0].c}`);
console.log(`  with notion_id:               ${withNotion[0].c}`);
console.log(`  with producer_email:          ${withProducer[0].c}`);
console.log(`  with repurpose_view_minimum:  ${withViewMin[0].c}`);
console.log(`Repurpose mappings:             ${mappings[0].c}`);

console.log("\n=== Sample rows ===");
const samples = await sql`
  SELECT name, event, channels, repurpose_view_minimum, producer_email
  FROM formats
  WHERE notion_id IS NOT NULL
  ORDER BY name
  LIMIT 5
`;
for (const r of samples) {
  console.log(
    `  ${r.name.padEnd(45)} | event=${(r.event ?? "—").padEnd(24)} | channels=${JSON.stringify(r.channels).padEnd(20)} | viewMin=${r.repurpose_view_minimum ?? "—"} | producer=${r.producer_email ?? "—"}`
  );
}

console.log("\n=== Sample repurpose mappings ===");
const mapRows = await sql`
  SELECT src.name AS source, tgt.name AS target
  FROM format_repurpose_mappings m
  JOIN formats src ON src.id = m.source_format_id
  JOIN formats tgt ON tgt.id = m.target_format_id
  LIMIT 10
`;
for (const r of mapRows) {
  console.log(`  ${r.source} → ${r.target}`);
}

await sql.end();
