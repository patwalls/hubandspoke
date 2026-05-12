#!/usr/bin/env node
/**
 * Backfill: Link MATG clips to their source originals via reposted_from_item_id.
 *
 * For clips, pillar_content_item_id already points to the source. This script
 * mirrors that relationship into reposted_from_item_id so the UI treats clips
 * like "reposts" (similar to Starter Story), making the lineage graph explicit.
 *
 * Idempotent: only updates clips where reposted_from_item_id IS NULL.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-matg-clip-reposts.mjs [--dry-run]
 */

import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

async function main() {
  console.log(`🔄 Linking MATG clips to source originals${dryRun ? " [dry-run]" : ""}...`);

  // Find clips that should be linked to their sources. Post-consolidation
  // (2026-05-11) clips live under sourceType='repurposed', identified by a
  // non-null source_clip_idea_id back-link to the originating clip-idea row.
  const candidates = await sql`
    SELECT
      id,
      title,
      pillar_content_item_id,
      reposted_from_item_id
    FROM production_items
    WHERE brand = 'matg'
      AND source_clip_idea_id IS NOT NULL
      AND reposted_from_item_id IS NULL
      AND pillar_content_item_id IS NOT NULL
    ORDER BY created_at ASC
  `;

  if (candidates.length === 0) {
    console.log("✅ No clips to link. All MATG clips already have reposted_from_item_id set.");
    await sql.end();
    return;
  }

  console.log(`Found ${candidates.length} clips to link.`);

  let linked = 0;
  for (const clip of candidates) {
    if (dryRun) {
      console.log(
        `   [dry] ${clip.id.substring(0, 8)}... "${clip.title?.substring(0, 50)}..." → pillar ${clip.pillar_content_item_id.substring(0, 8)}...`
      );
      linked++;
      continue;
    }

    try {
      await sql`
        UPDATE production_items
        SET reposted_from_item_id = ${clip.pillar_content_item_id},
            updated_at = NOW()
        WHERE id = ${clip.id}
      `;
      linked++;
      if (linked % 10 === 0) {
        console.log(`   ✓ Linked ${linked}/${candidates.length}...`);
      }
    } catch (err) {
      console.error(`   ❌ ${clip.id}: ${err.message}`);
    }
  }

  console.log(`✅ Linked ${linked} clips to their source originals.`);
  await sql.end();
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
