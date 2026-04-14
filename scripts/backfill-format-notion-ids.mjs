#!/usr/bin/env node
/**
 * One-time backfill: map each format's name to its Notion page ID.
 *
 * Queries the Notion Formats database, matches by name to our local formats
 * table, and writes the notion_page_id. This lets the threshold monitor
 * set the Format relation property when creating repurpose tasks.
 *
 * Usage:
 *   node scripts/backfill-format-notion-ids.mjs [--dry-run]
 */
import { Client } from "@notionhq/client";
import postgres from "postgres";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "..", ".env.local") });

const FORMATS_DB_ID = "2778e70a-6a3e-80f5-b9ed-d7d0a5f3ce16";
const DRY_RUN = process.argv.includes("--dry-run");

if (!process.env.NOTION_API_SECRET) {
  console.error("ERROR: NOTION_API_SECRET missing from .env.local");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing from .env.local");
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_SECRET });
const sql = postgres(process.env.DATABASE_URL, { prepare: false });

async function main() {
  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Backfilling format Notion page IDs...\n`);

  // 1. Fetch all formats from Notion
  const notionFormats = [];
  let hasMore = true;
  let nextCursor = undefined;

  while (hasMore) {
    const response = await notion.databases.query({
      database_id: FORMATS_DB_ID,
      page_size: 100,
      start_cursor: nextCursor,
    });

    for (const page of response.results) {
      const props = page.properties || {};
      const titleProp = props["Name"] || props["Title"];
      const titleParts = titleProp?.title || [];
      const name = titleParts.map((t) => t.plain_text).join("").trim();

      if (name) {
        notionFormats.push({ id: page.id, name });
      }
    }

    hasMore = response.has_more;
    nextCursor = response.next_cursor || undefined;
  }

  console.log(`Found ${notionFormats.length} formats in Notion\n`);

  // 2. Get local formats
  const localFormats = await sql`SELECT id, name, notion_page_id FROM formats`;
  const localByName = new Map(localFormats.map((f) => [f.name.toLowerCase().trim(), f]));

  console.log(`Found ${localFormats.length} formats in local DB\n`);

  // 3. Match and update
  let matched = 0;
  let alreadySet = 0;
  let notFound = 0;

  for (const nf of notionFormats) {
    const local = localByName.get(nf.name.toLowerCase().trim());

    if (!local) {
      console.log(`  SKIP (no local match): "${nf.name}" [${nf.id}]`);
      notFound++;
      continue;
    }

    if (local.notion_page_id === nf.id) {
      console.log(`  ALREADY SET: "${nf.name}"`);
      alreadySet++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  WOULD SET: "${nf.name}" → ${nf.id}`);
    } else {
      await sql`UPDATE formats SET notion_page_id = ${nf.id} WHERE id = ${local.id}`;
      console.log(`  UPDATED: "${nf.name}" → ${nf.id}`);
    }
    matched++;
  }

  console.log(`\nDone! Matched: ${matched}, Already set: ${alreadySet}, No local match: ${notFound}`);

  await sql.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
