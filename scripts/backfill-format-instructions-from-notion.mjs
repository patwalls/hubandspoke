#!/usr/bin/env node
/**
 * Backfill formats.instructions from each Format's Notion page body.
 *
 * Walks the block tree for every format with a notion_page_id,
 * converts common blocks to markdown, and writes the result into
 * formats.instructions.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-format-instructions-from-notion.mjs
 *   node --env-file=.env.local scripts/backfill-format-instructions-from-notion.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-format-instructions-from-notion.mjs --force   # overwrite non-empty
 *   node --env-file=.env.local scripts/backfill-format-instructions-from-notion.mjs --only <format_name>
 */
import { Client } from "@notionhq/client";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

if (!process.env.NOTION_API_SECRET) {
  console.error("NOTION_API_SECRET not set");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const sql = postgres(process.env.DATABASE_URL, { prepare: false, ssl });
const notion = new Client({ auth: process.env.NOTION_API_SECRET });

const FORMATS_DB_ID = "2778e70a-6a3e-80f5-b9ed-d7d0a5f3ce16";

function normalizeName(s) {
  return (s ?? "")
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-") // em/en dash → hyphen
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAllNotionFormats() {
  const out = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: FORMATS_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

function extractNotionTitle(page) {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === "title") {
      return (p.title ?? []).map((t) => t.plain_text ?? "").join("");
    }
  }
  return "";
}

// ---------- block -> markdown ----------

function richToMarkdown(rich) {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r) => {
      let t = r.plain_text ?? "";
      const a = r.annotations ?? {};
      if (a.code) t = "`" + t + "`";
      if (a.bold) t = "**" + t + "**";
      if (a.italic) t = "*" + t + "*";
      if (a.strikethrough) t = "~~" + t + "~~";
      if (r.href) t = `[${t}](${r.href})`;
      return t;
    })
    .join("");
}

async function listAllChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Walk children into markdown. `indent` is the prefix applied to every line
// a block emits, so nested lists/toggles stay visually nested.
async function blocksToMarkdown(blockId, indent = "") {
  const children = await listAllChildren(blockId);
  const lines = [];
  let numberedCounter = 0;
  let lastType = null;

  for (const b of children) {
    if (b.type !== "numbered_list_item") numberedCounter = 0;

    const emit = (text) => lines.push(indent + text);
    const emitChildren = async (extraIndent) => {
      if (b.has_children) {
        const nested = await blocksToMarkdown(b.id, indent + extraIndent);
        if (nested) lines.push(nested);
      }
    };

    switch (b.type) {
      case "paragraph": {
        const t = richToMarkdown(b.paragraph.rich_text);
        if (t) emit(t);
        else emit(""); // preserve spacing for blank paragraphs
        await emitChildren("  ");
        break;
      }
      case "heading_1":
        emit("# " + richToMarkdown(b.heading_1.rich_text));
        await emitChildren("  ");
        break;
      case "heading_2":
        emit("## " + richToMarkdown(b.heading_2.rich_text));
        await emitChildren("  ");
        break;
      case "heading_3":
        emit("### " + richToMarkdown(b.heading_3.rich_text));
        await emitChildren("  ");
        break;
      case "bulleted_list_item":
        emit("- " + richToMarkdown(b.bulleted_list_item.rich_text));
        await emitChildren("  ");
        break;
      case "numbered_list_item":
        numberedCounter += 1;
        emit(`${numberedCounter}. ` + richToMarkdown(b.numbered_list_item.rich_text));
        await emitChildren("   ");
        break;
      case "to_do": {
        const box = b.to_do.checked ? "[x]" : "[ ]";
        emit(`- ${box} ` + richToMarkdown(b.to_do.rich_text));
        await emitChildren("  ");
        break;
      }
      case "toggle":
        emit("- " + richToMarkdown(b.toggle.rich_text));
        await emitChildren("  ");
        break;
      case "quote":
        emit("> " + richToMarkdown(b.quote.rich_text));
        await emitChildren("> ");
        break;
      case "callout":
        emit("> " + richToMarkdown(b.callout.rich_text));
        await emitChildren("> ");
        break;
      case "code": {
        const lang = b.code.language ?? "";
        const body = richToMarkdown(b.code.rich_text);
        emit("```" + lang);
        for (const line of body.split("\n")) emit(line);
        emit("```");
        break;
      }
      case "divider":
        emit("---");
        break;
      case "bookmark":
        if (b.bookmark?.url) emit(b.bookmark.url);
        break;
      case "embed":
        if (b.embed?.url) emit(b.embed.url);
        break;
      case "video":
        if (b.video?.external?.url) emit(b.video.external.url);
        else if (b.video?.file?.url) emit(b.video.file.url);
        break;
      case "image": {
        const url = b.image?.external?.url ?? b.image?.file?.url;
        const cap = richToMarkdown(b.image?.caption ?? []);
        if (url) emit(`![${cap}](${url})`);
        break;
      }
      case "file":
      case "pdf": {
        const block = b[b.type];
        const url = block?.external?.url ?? block?.file?.url;
        if (url) emit(url);
        break;
      }
      case "link_to_page":
        // skip — we don't have the title
        break;
      case "child_page":
        if (b.child_page?.title) emit(`**${b.child_page.title}**`);
        break;
      case "table":
      case "column_list":
      case "column":
      case "synced_block":
        await emitChildren("");
        break;
      default:
        // Unknown type — try to pull rich_text if present.
        if (b[b.type]?.rich_text) {
          const t = richToMarkdown(b[b.type].rich_text);
          if (t) emit(t);
        }
        await emitChildren("  ");
        break;
    }
    lastType = b.type;
  }

  return lines.join("\n");
}

// ---------- main ----------

async function main() {
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Backfilling formats.instructions from Notion${
      FORCE ? " (FORCE)" : ""
    }${ONLY ? ` (only: ${ONLY})` : ""}`,
  );

  const rows = ONLY
    ? await sql`
        SELECT id, name, notion_page_id, instructions
        FROM formats
        WHERE name = ${ONLY}
        ORDER BY name
      `
    : await sql`
        SELECT id, name, notion_page_id, instructions
        FROM formats
        ORDER BY name
      `;

  console.log(`Fetching Notion Formats DB for name-based fallback matches…`);
  const notionPages = await fetchAllNotionFormats();
  const byName = new Map();
  for (const page of notionPages) {
    const title = extractNotionTitle(page);
    if (title) byName.set(normalizeName(title), page);
  }
  console.log(`Indexed ${byName.size} Notion format pages by name\n`);

  console.log(`Found ${rows.length} DB formats to process\n`);

  let updated = 0;
  let skipped = 0;
  let empty = 0;
  let failed = 0;
  let noMatch = 0;
  let pageIdBackfilled = 0;

  for (const r of rows) {
    try {
      if (!FORCE && r.instructions && r.instructions.trim().length > 0) {
        console.log(`⏭  SKIP   ${r.name} (already has ${r.instructions.length} chars, use --force to overwrite)`);
        skipped++;
        continue;
      }

      let pageId = r.notion_page_id;
      let matchedByName = false;
      if (!pageId) {
        const match = byName.get(normalizeName(r.name));
        if (match) {
          pageId = match.id;
          matchedByName = true;
        }
      }

      if (!pageId) {
        console.log(`?  NO-MATCH ${r.name} (no notion_page_id, no name match in Notion)`);
        noMatch++;
        continue;
      }

      const md = (await blocksToMarkdown(pageId)).trim();

      if (!md) {
        console.log(`∅  EMPTY  ${r.name}`);
        empty++;
        continue;
      }

      const tag = matchedByName ? " [name-match]" : "";
      console.log(`✓  ${DRY_RUN ? "WOULD " : ""}WRITE ${r.name}${tag} (${md.length} chars)`);
      if (!DRY_RUN) {
        if (matchedByName) {
          await sql`
            UPDATE formats
            SET instructions = ${md}, notion_page_id = ${pageId}, updated_at = NOW()
            WHERE id = ${r.id}
          `;
          pageIdBackfilled++;
        } else {
          await sql`
            UPDATE formats
            SET instructions = ${md}, updated_at = NOW()
            WHERE id = ${r.id}
          `;
        }
      }
      updated++;
    } catch (err) {
      console.error(`✗  FAIL   ${r.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\nDone. updated=${updated} skipped=${skipped} empty=${empty} no-match=${noMatch} failed=${failed} page_id_backfilled=${pageIdBackfilled}${DRY_RUN ? " (dry run — no writes)" : ""}`,
  );
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
