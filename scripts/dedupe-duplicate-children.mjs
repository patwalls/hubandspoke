/**
 * Dedupe (pillar, format) duplicate children.
 *
 * Usage:
 *   node --env-file=.env.local scripts/dedupe-duplicate-children.mjs            # dry-run
 *   node --env-file=.env.local scripts/dedupe-duplicate-children.mjs --apply    # archive + delete
 *
 * Heuristic per duplicate group (same pillar_content_item_id + lower(format)):
 *   - Winner: highest views, break ties by oldest created_at, then id ASC.
 *   - A loser is "safe" to auto-dedupe iff:
 *       views = 0 (or NULL) AND status <> 'Published' AND notion_id IS NOT NULL
 *   - Unsafe losers are reported only — the user triages them manually
 *     (typically: rename format or re-tag in Notion).
 *
 * --apply does two things per safe loser:
 *   1. Archive the Notion page (pages.update({ archived: true })).
 *   2. Delete the production_items row.
 *
 * Order matters: archive first. If Notion archive fails, skip the delete so
 * the next sync can still see the page and the scan will still flag it.
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

function isSafeLoser(row) {
  const views = Number(row.views ?? 0);
  if (views > 0) return false;
  if ((row.status ?? "").toLowerCase() === "published") return false;
  if (!row.notion_id) return false;
  return true;
}

function compareForWinner(a, b) {
  const va = Number(a.views ?? 0);
  const vb = Number(b.views ?? 0);
  if (va !== vb) return vb - va; // higher views first
  const ca = a.created_at?.getTime?.() ?? 0;
  const cb = b.created_at?.getTime?.() ?? 0;
  if (ca !== cb) return ca - cb; // older first
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
    ORDER BY pillar_content_item_id, lower(format), views DESC NULLS LAST, created_at ASC
  `;

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.pillar_content_item_id}|${r.format.toLowerCase().trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  if (groups.size === 0) {
    console.log("No duplicate groups. Nothing to do.");
    process.exit(0);
  }

  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${groups.size} duplicate group(s) across ${rows.length} row(s).\n`);

  const pillarTitleCache = new Map();
  async function pillarTitle(id) {
    if (pillarTitleCache.has(id)) return pillarTitleCache.get(id);
    const [row] = await sql`SELECT title FROM production_items WHERE id = ${id}`;
    const t = row?.title ?? "(unknown pillar)";
    pillarTitleCache.set(id, t);
    return t;
  }

  let safeArchived = 0;
  let safeSkippedNotionError = 0;
  let unsafeReported = 0;

  for (const [, members] of groups) {
    members.sort(compareForWinner);
    const winner = members[0];
    const losers = members.slice(1);
    const pTitle = await pillarTitle(winner.pillar_content_item_id);

    console.log(`Pillar: ${pTitle} (${winner.pillar_content_item_id})`);
    console.log(`  format=${winner.format.toLowerCase().trim()}  (${members.length} rows)`);
    console.log(`  KEEP   ${winner.id}  views=${winner.views ?? 0}  status=${winner.status ?? ""}  "${winner.title ?? ""}"`);

    for (const loser of losers) {
      const safe = isSafeLoser(loser);
      const label = safe ? "REMOVE" : "SKIP  ";
      console.log(
        `  ${label} ${loser.id}  views=${loser.views ?? 0}  status=${loser.status ?? ""}  notion_id=${loser.notion_id ?? "(none)"}  "${loser.title ?? ""}"`
      );

      if (!safe) {
        unsafeReported++;
        continue;
      }
      if (!APPLY) {
        safeArchived++; // tracked as "would archive"
        continue;
      }

      try {
        await notion.pages.update({ page_id: loser.notion_id, archived: true });
      } catch (err) {
        safeSkippedNotionError++;
        console.log(`         !! Notion archive failed: ${err?.message ?? err} — leaving DB row.`);
        continue;
      }
      await sql`DELETE FROM production_items WHERE id = ${loser.id}`;
      safeArchived++;
    }
    console.log();
  }

  console.log("---");
  console.log(`${APPLY ? "Archived + deleted" : "Would archive"}: ${safeArchived}`);
  if (safeSkippedNotionError > 0) {
    console.log(`Skipped due to Notion errors: ${safeSkippedNotionError}`);
  }
  console.log(`Unsafe (needs manual triage): ${unsafeReported}`);
  if (!APPLY) {
    console.log("\nRe-run with --apply to execute.");
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
