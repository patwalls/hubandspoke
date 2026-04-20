#!/usr/bin/env node
/**
 * Backfill content_comments from Notion page comments.
 *
 * For each production_items row with a notion_id, fetches the page's
 * open comments from the Notion API and upserts them into
 * content_comments, keyed on notion_comment_id so re-runs are safe.
 *
 * Known limitation: Notion's API only returns unresolved comments.
 * Resolved discussions cannot be read via the public API.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-notion-comments.mjs
 *   node --env-file=.env.local scripts/backfill-notion-comments.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-notion-comments.mjs --only <notion_id>
 */
import { Client } from "@notionhq/client";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : null;

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

// Notion rate limit is ~3 req/sec; 400ms keeps us under even with bursts.
const SLEEP_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function richToPlain(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map((r) => r.plain_text ?? "").join("");
}

async function withRetry(fn, label) {
  const MAX = 6;
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
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60000, 2 ** attempt * 1000);
      console.log(`   ⏳ ${label}: ${err.code ?? err.status} — sleeping ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX})`);
      await sleep(waitMs);
    }
  }
}

async function listPageComments(pageId) {
  const all = [];
  let cursor;
  do {
    const res = await withRetry(
      () =>
        notion.comments.list({
          block_id: pageId,
          start_cursor: cursor,
          page_size: 100,
        }),
      `comments.list ${pageId}`,
    );
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function upsertUserByEmail({ email, name, avatarUrl }) {
  if (!email) return null;
  const normalized = email.toLowerCase().trim();
  if (!normalized) return null;
  const rows = await sql`
    INSERT INTO users (email, name, avatar_url)
    VALUES (${normalized}, ${name}, ${avatarUrl})
    ON CONFLICT (email) DO UPDATE SET
      name = COALESCE(users.name, EXCLUDED.name),
      avatar_url = EXCLUDED.avatar_url,
      updated_at = NOW()
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

async function main() {
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Backfilling content_comments from Notion${
      ONLY ? ` (only: ${ONLY})` : ""
    }`,
  );

  const items = ONLY
    ? await sql`
        SELECT id, notion_id, title
        FROM production_items
        WHERE notion_id = ${ONLY}
      `
    : LIMIT
      ? await sql`
          SELECT id, notion_id, title
          FROM production_items
          WHERE notion_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT ${LIMIT}
        `
      : await sql`
          SELECT id, notion_id, title
          FROM production_items
          WHERE notion_id IS NOT NULL
          ORDER BY created_at DESC
        `;

  console.log(`Scanning ${items.length} production item(s)\n`);

  let totalFetched = 0;
  let inserted = 0;
  let updated = 0;
  let skippedNoBody = 0;
  let itemsWithComments = 0;
  let itemsFailed = 0;

  for (const item of items) {
    try {
      const comments = await listPageComments(item.notion_id);
      await sleep(SLEEP_MS);

      if (comments.length === 0) continue;
      itemsWithComments++;
      totalFetched += comments.length;

      const titleShort = (item.title ?? "(untitled)").slice(0, 60);
      console.log(`\n→ ${titleShort}  [${comments.length} comment(s)]`);

      for (const c of comments) {
        const body = richToPlain(c.rich_text).trim();
        if (!body) {
          skippedNoBody++;
          console.log(`   ∅  SKIP empty ${c.id}`);
          continue;
        }

        const createdBy = c.created_by ?? {};
        const email = createdBy.person?.email ?? null;
        const displayName = createdBy.name ?? null;
        const avatarUrl = createdBy.avatar_url ?? null;

        let userId = null;
        if (email) {
          userId = DRY_RUN
            ? null
            : await upsertUserByEmail({ email, name: displayName, avatarUrl });
        }

        const editedAt =
          c.last_edited_time && c.last_edited_time !== c.created_time
            ? c.last_edited_time
            : null;

        if (DRY_RUN) {
          console.log(
            `   ✓  WOULD UPSERT ${c.id}  by=${email ?? "anon"}  len=${body.length}`,
          );
          inserted++;
          continue;
        }

        // ON CONFLICT target must match the partial unique index predicate
        // (WHERE notion_comment_id IS NOT NULL) in drizzle/0003_*.sql.
        const result = await sql`
          INSERT INTO content_comments
            (notion_comment_id, content_item_id, user_id, body, created_at, edited_at)
          VALUES
            (${c.id}, ${item.id}, ${userId}, ${body},
             ${c.created_time}, ${editedAt})
          ON CONFLICT (notion_comment_id) WHERE notion_comment_id IS NOT NULL
          DO UPDATE SET
            body = EXCLUDED.body,
            edited_at = EXCLUDED.edited_at,
            user_id = EXCLUDED.user_id
          RETURNING (xmax = 0) AS was_insert
        `;
        const row = result[0];
        if (row.was_insert) {
          inserted++;
          console.log(`   ✓  INSERT ${c.id}  by=${email ?? "anon"}  len=${body.length}`);
        } else {
          updated++;
          console.log(`   ↻  UPDATE ${c.id}  by=${email ?? "anon"}  len=${body.length}`);
        }
      }
    } catch (err) {
      itemsFailed++;
      console.error(`✗  FAIL  ${item.notion_id}: ${err.message}`);
    }
  }

  console.log(
    `\nDone. items_scanned=${items.length} items_with_comments=${itemsWithComments} fetched=${totalFetched} inserted=${inserted} updated=${updated} skipped_empty=${skippedNoBody} items_failed=${itemsFailed}${DRY_RUN ? " (dry run — no writes)" : ""}`,
  );

  if (!DRY_RUN) {
    await sql`
      INSERT INTO sync_logs (sync_type, status, items_fetched, items_created, items_updated, completed_at)
      VALUES ('notion_comments_backfill', 'completed', ${totalFetched}, ${inserted}, ${updated}, NOW())
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
