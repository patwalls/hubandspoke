#!/usr/bin/env node
/**
 * TEMPORARY one-time script — delete after format import is verified.
 *
 * Discovers Pat's Notion Formats database and prints its schema + 3 sample
 * pages so we know the exact property names & types before writing the
 * importer.
 *
 * Usage:
 *   node scripts/discover-notion-formats.mjs
 *     → Lists candidate databases (search for "Format")
 *
 *   node scripts/discover-notion-formats.mjs <full-database-id>
 *     → Prints the full schema + 3 sample pages for that DB
 */
import { Client } from "@notionhq/client";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local from project root
config({ path: resolve(__dirname, "..", ".env.local") });

if (!process.env.NOTION_API_SECRET) {
  console.error("ERROR: NOTION_API_SECRET not found in .env.local");
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_SECRET });

const dbId = process.argv[2];

async function main() {
  if (!dbId) {
    console.log("Searching Notion for databases matching 'Format'...\n");
    const result = await notion.search({
      query: "Format",
      filter: { property: "object", value: "database" },
    });

    const candidates = result.results.map((r) => ({
      id: r.id,
      idNormalized: r.id.replace(/-/g, ""),
      startsWith2778e70a: r.id.replace(/-/g, "").startsWith("2778e70a"),
      title: r.title?.map((t) => t.plain_text ?? "").join("") || "(untitled)",
      url: r.url,
    }));

    console.log(`Found ${candidates.length} database(s):\n`);
    for (const c of candidates) {
      const marker = c.startsWith2778e70a ? " <-- MATCHES 2778e70a" : "";
      console.log(`  ${c.title}${marker}`);
      console.log(`    id:  ${c.id}`);
      console.log(`    url: ${c.url}`);
      console.log();
    }

    console.log("Next step: run");
    console.log(
      "  node scripts/discover-notion-formats.mjs <id-from-above>"
    );
    return;
  }

  console.log(`Fetching schema for database: ${dbId}\n`);
  const database = await notion.databases.retrieve({ database_id: dbId });

  console.log("=== SCHEMA ===");
  console.log(
    "Title:",
    database.title?.map((t) => t.plain_text ?? "").join("") || "(untitled)"
  );
  console.log("\nProperties:");
  for (const [name, prop] of Object.entries(database.properties)) {
    console.log(`  "${name}" → ${prop.type}`);
  }

  console.log("\n=== SAMPLE PAGES (3) ===");
  const query = await notion.databases.query({
    database_id: dbId,
    page_size: 3,
  });

  for (const page of query.results) {
    console.log(`\n--- Page ${page.id} ---`);
    console.log(JSON.stringify(page.properties, null, 2));
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
