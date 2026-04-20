/**
 * Orphan the "loser" rows in each (pillar, format) duplicate group so the
 * uniq_production_items_pillar_format index can apply.
 *
 * Usage:
 *   node --env-file=.env.local scripts/orphan-duplicate-children.mjs          # dry-run
 *   node --env-file=.env.local scripts/orphan-duplicate-children.mjs --apply  # execute
 *
 * Per duplicate group:
 *   - Winner: highest views, tie-break on oldest created_at, then id ASC.
 *   - Losers: the rest. For each loser:
 *       1. Clear the "Pillar Content" relation on the Notion page (so the
 *          next sync doesn't re-attach it).
 *       2. NULL out pillar_content_notion_id and pillar_content_item_id on
 *          the DB row.
 *   Losers keep all their other data (title, views, status, etc.) — they
 *   just become pillar-less.
 *
 * Notion update is attempted first. If it fails, DB is not touched for that
 * row, so the scan will still flag it next run.
 */

import postgres from "postgres";
import { Client } from "@notionhq/client";

const APPLY = process.argv.includes("--apply");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const notionToken = process.env.NOTION_API_SECRET;
if (APPLY && !notionToken) {
  console.error("NOTION_API_SECRET not set (required for --apply)");
  process.exit(1);
}

const sql = postgres(url, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});
const notion = notionToken ? new Client({ auth: notionToken }) : null;

function compareForWinner(a, b) {
  const va = Number(a.views ?? 0);
  const vb = Number(b.views ?? 0);
  if (va !== vb) return vb - va;
  const ca = a.created_at?.getTime?.() ?? 0;
  const cb = b.created_at?.getTime?.() ?? 0;
  if (ca !== cb) return ca - cb;
  return String(a.id).localeCompare(String(b.id));
}

try {
  const rows = await sql`
    SELECT
      id,
      notion_id,
      title,
      status,
      views,
      format,
      pillar_content_item_id,
      created_at
    FROM production_items
    WHERE pillar_content_item_id IS NOT NULL
      AND format IS NOT NULL
      AND (pillar_content_item_id, lower(format)) IN (
        SELECT pillar_content_item_id, lower(format)
        FROM production_items
        WHERE pillar_content_item_id IS NOT NULL AND format IS NOT NULL
        GROUP BY pillar_content_item_id, lower(format)
        HAVING count(*) > 1
      )
  `;

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.pillar_content_item_id}|${r.format.toLowerCase().trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  if (groups.size === 0) {
    console.log("No duplicate groups. Nothing to orphan.");
    process.exit(0);
  }

  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"}: ${groups.size} duplicate group(s), ${rows.length} row(s).\n`
  );

  const pillarTitleCache = new Map();
  async function pillarTitle(id) {
    if (pillarTitleCache.has(id)) return pillarTitleCache.get(id);
    const [row] = await sql`SELECT title FROM production_items WHERE id = ${id}`;
    const t = row?.title ?? "(unknown pillar)";
    pillarTitleCache.set(id, t);
    return t;
  }

  let orphanedOk = 0;
  let orphanedNotionError = 0;
  let orphanedNoNotionId = 0;

  for (const [, members] of groups) {
    members.sort(compareForWinner);
    const winner = members[0];
    const losers = members.slice(1);
    const pTitle = await pillarTitle(winner.pillar_content_item_id);

    console.log(`Pillar: ${pTitle} (${winner.pillar_content_item_id})`);
    console.log(`  format=${winner.format.toLowerCase().trim()}  (${members.length} rows)`);
    console.log(
      `  KEEP    ${winner.id}  views=${winner.views ?? 0}  status=${winner.status ?? ""}  "${winner.title ?? ""}"`
    );

    for (const loser of losers) {
      console.log(
        `  ORPHAN  ${loser.id}  views=${loser.views ?? 0}  status=${loser.status ?? ""}  notion_id=${loser.notion_id ?? "(none)"}  "${loser.title ?? ""}"`
      );

      if (!APPLY) continue;

      if (loser.notion_id) {
        try {
          await notion.pages.update({
            page_id: loser.notion_id,
            properties: {
              "Pillar Content": { relation: [] },
            },
          });
        } catch (err) {
          orphanedNotionError++;
          console.log(`          !! Notion update failed: ${err?.message ?? err} — leaving DB row.`);
          continue;
        }
      } else {
        orphanedNoNotionId++;
      }

      await sql`
        UPDATE production_items
        SET pillar_content_notion_id = NULL,
            pillar_content_item_id = NULL
        WHERE id = ${loser.id}
      `;
      orphanedOk++;
    }
    console.log();
  }

  console.log("---");
  console.log(`${APPLY ? "Orphaned" : "Would orphan"}: ${orphanedOk}`);
  if (orphanedNotionError > 0) {
    console.log(`Notion update errors (DB not touched): ${orphanedNotionError}`);
  }
  if (orphanedNoNotionId > 0) {
    console.log(`Rows with no notion_id (DB-only update): ${orphanedNoNotionId}`);
  }
  if (!APPLY) {
    console.log("\nRe-run with --apply to execute.");
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
