#!/usr/bin/env node
/**
 * TEMPORARY one-time migration — delete after the import is verified.
 *
 * Pulls every Format row from Pat's Notion Formats database into the
 * local `formats` table (and populates `format_repurpose_mappings`).
 *
 * After this runs successfully:
 *   - Hub&Spoke becomes the source of truth for formats
 *   - Future creates/edits/deletes happen via the /formats UI
 *   - Delete this script + discover-notion-formats.mjs
 *
 * Usage:
 *   node scripts/import-formats-from-notion.mjs [--dry-run]
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

// -------- Extractors --------

function extractTitle(prop) {
  if (!prop || prop.type !== "title") return null;
  return prop.title?.map((t) => t.plain_text ?? "").join("") || null;
}

function extractSelect(prop) {
  if (!prop || prop.type !== "select") return null;
  return prop.select?.name ?? null;
}

function extractNumber(prop) {
  if (!prop || prop.type !== "number") return null;
  return typeof prop.number === "number" ? prop.number : null;
}

function extractCheckbox(prop) {
  if (!prop || prop.type !== "checkbox") return false;
  return Boolean(prop.checkbox);
}

function extractFirstPerson(prop) {
  if (!prop || prop.type !== "people") return { email: null, userId: null };
  const first = prop.people?.[0];
  if (!first) return { email: null, userId: null };
  return {
    email: first.person?.email ?? null,
    userId: first.id ?? null,
  };
}

function extractRelationIds(prop) {
  if (!prop || prop.type !== "relation") return [];
  return (prop.relation ?? []).map((r) => r.id);
}

// -------- Fetch all format pages (paginated) --------

async function fetchAllFormats() {
  const all = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: FORMATS_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return all;
}

// -------- Main --------

async function main() {
  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Importing formats from Notion...\n`);

  const pages = await fetchAllFormats();
  console.log(`Fetched ${pages.length} format pages from Notion\n`);

  // Build extracted records
  const records = pages.map((page) => {
    const p = page.properties;
    const producer = extractFirstPerson(p["Producer"]);
    const editorCreator = extractFirstPerson(p["Editor/Creator"]);
    const channelName = extractSelect(p["Channel"]);
    return {
      notionId: page.id,
      name: extractTitle(p["Name"]) || "(Untitled)",
      event: extractSelect(p["Event"]),
      channels: channelName ? [channelName] : [],
      repurposeViewMinimum: extractNumber(p["Repurpose View Minimum"]),
      platformRepurpose: extractCheckbox(p["Platform Repurpose"]),
      producerEmail: producer.email,
      producerNotionUserId: producer.userId,
      editorCreatorEmail: editorCreator.email,
      editorCreatorNotionUserId: editorCreator.userId,
      properties: p, // raw catch-all
      repurposeTargetIds: extractRelationIds(p["Repurpose"]),
    };
  });

  // Deduplicate by name to avoid unique-constraint collisions.
  // If two Notion pages share a name, keep the later-edited one
  // (we pick the one that appears later in the Notion response, which
  // is effectively last-writer-wins — safer than failing the whole import).
  const byName = new Map();
  for (const r of records) {
    byName.set(r.name, r);
  }
  const unique = [...byName.values()];
  if (unique.length !== records.length) {
    console.log(
      `Note: deduplicated ${records.length - unique.length} rows that shared a name\n`
    );
  }

  if (DRY_RUN) {
    console.log("[DRY RUN] Would import these formats:");
    for (const r of unique) {
      console.log(
        `  - ${r.name} (event: ${r.event ?? "—"}, channel: ${
          r.channels[0] ?? "—"
        }, viewMin: ${r.repurposeViewMinimum ?? "—"})`
      );
    }
    console.log(`\n[DRY RUN] Total: ${unique.length} formats`);
    await sql.end();
    return;
  }

  // Upsert formats one by one. We match on `name` (which is the existing
  // unique key) AND store `notion_id` so re-runs are stable. Any existing
  // manually-created row with the same name gets enriched with Notion data.
  let created = 0;
  let updated = 0;
  const notionIdToLocalId = new Map();

  for (const r of unique) {
    const result = await sql`
      INSERT INTO formats (
        notion_id, name, event, channels, repurpose_view_minimum,
        platform_repurpose, producer_email, producer_notion_user_id,
        editor_creator_email, editor_creator_notion_user_id, properties,
        updated_at
      ) VALUES (
        ${r.notionId}, ${r.name}, ${r.event}, ${JSON.stringify(r.channels)}::jsonb,
        ${r.repurposeViewMinimum}, ${r.platformRepurpose},
        ${r.producerEmail}, ${r.producerNotionUserId},
        ${r.editorCreatorEmail}, ${r.editorCreatorNotionUserId},
        ${JSON.stringify(r.properties)}::jsonb,
        NOW()
      )
      ON CONFLICT (name) DO UPDATE SET
        notion_id = EXCLUDED.notion_id,
        event = EXCLUDED.event,
        channels = EXCLUDED.channels,
        repurpose_view_minimum = EXCLUDED.repurpose_view_minimum,
        platform_repurpose = EXCLUDED.platform_repurpose,
        producer_email = EXCLUDED.producer_email,
        producer_notion_user_id = EXCLUDED.producer_notion_user_id,
        editor_creator_email = EXCLUDED.editor_creator_email,
        editor_creator_notion_user_id = EXCLUDED.editor_creator_notion_user_id,
        properties = EXCLUDED.properties,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS inserted
    `;
    const row = result[0];
    notionIdToLocalId.set(r.notionId, row.id);
    if (row.inserted) created++;
    else updated++;
  }

  console.log(`Formats: ${created} created, ${updated} updated`);

  // Rebuild format_repurpose_mappings from the Notion "Repurpose" relation.
  // Clear first (only for the formats we just imported), then re-insert.
  const sourceIds = [...notionIdToLocalId.values()];
  if (sourceIds.length > 0) {
    await sql`
      DELETE FROM format_repurpose_mappings
      WHERE source_format_id = ANY(${sourceIds}::uuid[])
    `;
  }

  let mappingsCreated = 0;
  for (const r of unique) {
    const sourceId = notionIdToLocalId.get(r.notionId);
    if (!sourceId) continue;
    for (const targetNotionId of r.repurposeTargetIds) {
      const targetId = notionIdToLocalId.get(targetNotionId);
      if (!targetId) continue; // target wasn't imported, skip
      try {
        await sql`
          INSERT INTO format_repurpose_mappings (source_format_id, target_format_id)
          VALUES (${sourceId}, ${targetId})
          ON CONFLICT DO NOTHING
        `;
        mappingsCreated++;
      } catch (err) {
        console.warn(
          `  Skipped mapping ${sourceId} → ${targetId}: ${err.message}`
        );
      }
    }
  }
  console.log(`Repurpose mappings: ${mappingsCreated} created`);

  // Log the sync
  await sql`
    INSERT INTO sync_logs (sync_type, status, items_fetched, items_created, items_updated, completed_at)
    VALUES ('formats_initial_import', 'success', ${pages.length}, ${created}, ${updated}, NOW())
  `;

  console.log("\n✓ Import complete.");
  await sql.end();
}

main().catch(async (err) => {
  console.error("IMPORT FAILED:", err);
  try {
    await sql`
      INSERT INTO sync_logs (sync_type, status, error_message, completed_at)
      VALUES ('formats_initial_import', 'error', ${err.message}, NOW())
    `;
  } catch {}
  await sql.end();
  process.exit(1);
});
