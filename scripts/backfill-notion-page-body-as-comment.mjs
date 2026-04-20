#!/usr/bin/env node
/**
 * Backfill each Notion content page's *body* (caption, Canva links, notes,
 * everything below the property columns) into content_comments as one
 * comment attributed to the item's editor.
 *
 * Idempotent: keyed on notion_comment_id = `page-body:<notion_id>`. Re-runs
 * update the body and bump edited_at.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-notion-page-body-as-comment.mjs
 *   node --env-file=.env.local scripts/backfill-notion-page-body-as-comment.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-notion-page-body-as-comment.mjs --only <notion_id>
 *   node --env-file=.env.local scripts/backfill-notion-page-body-as-comment.mjs --statuses "Final Review,Review"
 *   node --env-file=.env.local scripts/backfill-notion-page-body-as-comment.mjs --limit 50
 */
import { Client } from "@notionhq/client";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : null;
const statusesIdx = process.argv.indexOf("--statuses");
const STATUSES =
  statusesIdx >= 0 && process.argv[statusesIdx + 1]
    ? process.argv[statusesIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : null;
const SKIP_EXISTING = process.argv.includes("--skip-existing");

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

const SLEEP_MS = 900;
const COOLDOWN_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  const MAX = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient =
        err?.code === "rate_limited" ||
        err?.status === 429 ||
        err?.status === 502 ||
        err?.status === 503 ||
        err?.status === 504;
      if (!transient || attempt >= MAX) throw err;
      const retryAfter = Number(err?.headers?.["retry-after"]);
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(300000, 2 ** attempt * 1000);
      console.log(
        `   ⏳ ${label}: ${err.code ?? err.status} — sleeping ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX})`,
      );
      await sleep(waitMs);
    }
  }
}

// ---------- block → markdown (adapted from backfill-format-instructions-from-notion.mjs) ----------

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
    const res = await withRetry(
      () =>
        notion.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        }),
      `blocks.children.list ${blockId}`,
    );
    await sleep(SLEEP_MS);
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function blocksToMarkdown(blockId, indent = "") {
  const children = await listAllChildren(blockId);
  const lines = [];
  let numberedCounter = 0;

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
        else emit("");
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
        if (b[b.type]?.rich_text) {
          const t = richToMarkdown(b[b.type].rich_text);
          if (t) emit(t);
        }
        await emitChildren("  ");
        break;
    }
  }

  return lines.join("\n");
}

// ---------- main ----------

async function main() {
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Backfilling page body as comment${
      ONLY ? ` (only: ${ONLY})` : ""
    }${STATUSES ? ` (statuses: ${STATUSES.join(", ")})` : ""}${LIMIT ? ` (limit: ${LIMIT})` : ""}`,
  );

  const items = ONLY
    ? await sql`
        SELECT id, notion_id, title, status, editor_email, editor_name
        FROM production_items
        WHERE notion_id = ${ONLY}
      `
    : STATUSES
      ? (LIMIT
          ? await sql`
              SELECT id, notion_id, title, status, editor_email, editor_name
              FROM production_items
              WHERE notion_id IS NOT NULL
                AND status = ANY(${STATUSES})
              ORDER BY created_at DESC
              LIMIT ${LIMIT}
            `
          : await sql`
              SELECT id, notion_id, title, status, editor_email, editor_name
              FROM production_items
              WHERE notion_id IS NOT NULL
                AND status = ANY(${STATUSES})
              ORDER BY created_at DESC
            `)
      : (LIMIT
          ? await sql`
              SELECT id, notion_id, title, status, editor_email, editor_name
              FROM production_items
              WHERE notion_id IS NOT NULL
              ORDER BY
                CASE status
                  WHEN 'Final Review'     THEN 1
                  WHEN 'Review'           THEN 2
                  WHEN 'Ready To Publish' THEN 3
                  WHEN 'Assigned'         THEN 4
                  WHEN 'Idea'             THEN 5
                  WHEN 'Published'        THEN 6
                  WHEN 'Killed'           THEN 7
                  ELSE 8
                END,
                created_at DESC
              LIMIT ${LIMIT}
            `
          : await sql`
              SELECT id, notion_id, title, status, editor_email, editor_name
              FROM production_items
              WHERE notion_id IS NOT NULL
              ORDER BY
                CASE status
                  WHEN 'Final Review'     THEN 1
                  WHEN 'Review'           THEN 2
                  WHEN 'Ready To Publish' THEN 3
                  WHEN 'Assigned'         THEN 4
                  WHEN 'Idea'             THEN 5
                  WHEN 'Published'        THEN 6
                  WHEN 'Killed'           THEN 7
                  ELSE 8
                END,
                created_at DESC
            `);

  console.log(`Scanning ${items.length} item(s)\n`);

  // Cache of email (lowercased) -> users.id. Many items share an editor.
  const userIdCache = new Map();
  async function resolveEditorUserId(email) {
    if (!email) return null;
    const norm = email.toLowerCase().trim();
    if (!norm) return null;
    if (userIdCache.has(norm)) return userIdCache.get(norm);
    const rows = await sql`SELECT id FROM users WHERE email = ${norm} LIMIT 1`;
    const id = rows[0]?.id ?? null;
    userIdCache.set(norm, id);
    return id;
  }

  let inserted = 0;
  let updated = 0;
  let skippedEmpty = 0;
  let skippedAlreadyDone = 0;
  let failed = 0;

  for (const item of items) {
    const syntheticId = `page-body:${item.notion_id}`;
    try {
      if (SKIP_EXISTING) {
        const existing = await sql`
          SELECT 1 FROM content_comments
          WHERE notion_comment_id = ${syntheticId}
          LIMIT 1
        `;
        if (existing.length > 0) {
          skippedAlreadyDone++;
          continue;
        }
      }

      const md = (await blocksToMarkdown(item.notion_id)).trim();

      if (!md) {
        skippedEmpty++;
        continue;
      }

      const editorUserId = DRY_RUN ? null : await resolveEditorUserId(item.editor_email);
      const authorName = item.editor_name ?? item.editor_email ?? null;
      const titleShort = (item.title ?? "(untitled)").slice(0, 60);

      if (DRY_RUN) {
        console.log(
          `→ ${titleShort} [${item.status ?? "—"}]  editor=${item.editor_email ?? authorName ?? "—"}`,
        );
        console.log(`   ✓  WOULD UPSERT ${md.length} chars`);
        inserted++;
        continue;
      }

      const result = await sql`
        INSERT INTO content_comments
          (notion_comment_id, content_item_id, user_id, body, created_at, edited_at,
           author_name, author_avatar_url)
        VALUES
          (${syntheticId}, ${item.id}, ${editorUserId}, ${md},
           NOW(), NULL,
           ${authorName}, ${null})
        ON CONFLICT (notion_comment_id) WHERE notion_comment_id IS NOT NULL
        DO UPDATE SET
          body = EXCLUDED.body,
          user_id = EXCLUDED.user_id,
          author_name = EXCLUDED.author_name,
          edited_at = NOW()
        RETURNING (xmax = 0) AS was_insert
      `;
      const row = result[0];
      if (row.was_insert) {
        inserted++;
        console.log(`✓  INSERT  ${titleShort} [${item.status ?? "—"}]  by=${authorName ?? "—"}  len=${md.length}`);
      } else {
        updated++;
        console.log(`↻  UPDATE  ${titleShort} [${item.status ?? "—"}]  by=${authorName ?? "—"}  len=${md.length}`);
      }
    } catch (err) {
      failed++;
      console.error(`✗  FAIL  ${item.notion_id}: ${err.message}`);
      if (err?.code === "rate_limited" || err?.status === 429) {
        console.log(`   💤 cooldown ${Math.round(COOLDOWN_MS / 1000)}s to let Notion rate-limit window drain`);
        await sleep(COOLDOWN_MS);
      }
    }
  }

  console.log(
    `\nDone. scanned=${items.length} inserted=${inserted} updated=${updated} skipped_empty=${skippedEmpty} skipped_already_done=${skippedAlreadyDone} failed=${failed}${DRY_RUN ? " (dry run — no writes)" : ""}`,
  );

  if (!DRY_RUN) {
    await sql`
      INSERT INTO sync_logs (sync_type, status, items_fetched, items_created, items_updated, completed_at)
      VALUES ('notion_page_body_as_comment', 'completed', ${items.length}, ${inserted}, ${updated}, NOW())
    `;
  }
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
