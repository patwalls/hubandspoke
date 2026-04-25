/**
 * One-shot cleanup for duplicate productionItems rows that crept in before
 * URL-based dedup was canonicalized.
 *
 * Background: same post showed up twice for the same account because:
 *   - Manual "Add from link" stored a URL but never derived
 *     `platform_content_id`. Auto-sync stored the id but the URL didn't
 *     match exactly (threads.com vs threads.net, `?utm_source=…`, trailing
 *     slash). The partial unique index on `(account_id, platform_content_id)`
 *     never fired because one side was NULL.
 *
 * The runtime fix is in `src/lib/platform-url.ts` + the API + sync. This
 * script cleans up the rows already written.
 *
 * Phases:
 *   A. Backfill `platform_content_id` for any row where it's null but the
 *      URL is parseable.
 *   B. Merge duplicate rows. For each `(account_id, platform_content_id)`
 *      with >1 row: pick the most-curated row as winner, repoint every FK
 *      that points at a loser, fold over any non-null fields the winner is
 *      missing, take max of engagement counters, normalize the URL, then
 *      delete the losers.
 *   C. Delete Threads replies. Reply detection runs on the next sync and
 *      sets `is_reply=true`; this phase deletes those rows.
 *
 * Defaults to dry-run. Idempotent — safe to re-run.
 *
 *   node --env-file=.env.local scripts/cleanup-duplicate-social-posts.mjs
 *   node --env-file=.env.local scripts/cleanup-duplicate-social-posts.mjs --apply
 *   node --env-file=.env.local scripts/cleanup-duplicate-social-posts.mjs --apply --skip-replies
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;
const skipReplies = args.includes("--skip-replies");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const sql = postgres(databaseUrl, { max: 1, ssl, prepare: false });

// ─── Extractors / canonicalizers (mirrors src/lib/platform-url.ts) ───────

function platformOf(postTypeOrPlatform) {
  if (!postTypeOrPlatform) return null;
  const k = String(postTypeOrPlatform).toLowerCase();
  if (k.startsWith("youtube")) return "youtube";
  if (k.startsWith("instagram")) return "instagram";
  if (k === "threads") return "threads";
  if (k === "x" || k === "twitter") return "x";
  if (k === "tiktok") return "tiktok";
  if (k === "linkedin") return "linkedin";
  return null;
}

function extractContentId(postTypeOrPlatform, url) {
  if (!url) return null;
  const platform = platformOf(postTypeOrPlatform);
  if (!platform) return null;
  switch (platform) {
    case "youtube": {
      const m = url.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([\w-]{11})/);
      return m?.[1] ?? null;
    }
    case "instagram": {
      const m = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
      return m?.[1] ?? null;
    }
    case "threads": {
      const m = url.match(/\/post\/([A-Za-z0-9_-]+)/);
      return m?.[1] ?? null;
    }
    case "x": {
      const m = url.match(/\/status\/(\d+)/);
      return m?.[1] ?? null;
    }
    case "tiktok": {
      const m = url.match(/\/video\/(\d+)/);
      return m?.[1] ?? null;
    }
    case "linkedin": {
      const a = url.match(/activity[:-](\d+)/);
      if (a) return a[1];
      const u = url.match(/urn:li:(?:activity|share):(\d+)/);
      return u?.[1] ?? null;
    }
  }
  return null;
}

function canonicalPostUrl(postTypeOrPlatform, code, handle) {
  const platform = platformOf(postTypeOrPlatform);
  if (!platform) return null;
  const h = handle ? handle.replace(/^@/, "") : null;
  switch (platform) {
    case "instagram":
      return `https://www.instagram.com/p/${code}/`;
    case "threads":
      return h
        ? `https://www.threads.net/@${h}/post/${code}`
        : `https://www.threads.net/post/${code}`;
    case "x":
      return h
        ? `https://x.com/${h}/status/${code}`
        : `https://x.com/i/status/${code}`;
    case "tiktok":
      return h
        ? `https://www.tiktok.com/@${h}/video/${code}`
        : `https://www.tiktok.com/video/${code}`;
    case "youtube":
      return `https://www.youtube.com/watch?v=${code}`;
    case "linkedin":
      return `https://www.linkedin.com/feed/update/urn:li:activity:${code}/`;
  }
  return null;
}

// ─── Phase A — backfill platform_content_id ──────────────────────────────

async function phaseA() {
  console.log(`\n${dryRun ? "[dry-run]" : "[apply]"} Phase A — backfill platform_content_id`);
  const rows = await sql`
    SELECT pi.id, pi.youtube_id, pi.published_link, pi.post_type, a.platform
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.platform_content_id IS NULL
      AND pi.deleted_at IS NULL
      AND (pi.published_link IS NOT NULL OR pi.youtube_id IS NOT NULL)
  `;
  let derived = 0;
  let conflicts = 0;
  let unparseable = 0;
  const updates = [];
  for (const r of rows) {
    const id =
      r.youtube_id ?? extractContentId(r.post_type ?? r.platform, r.published_link);
    if (id) updates.push({ rowId: r.id, contentId: id });
    else unparseable++;
  }
  console.log(`  candidates=${rows.length} derivable=${updates.length} unparseable=${unparseable}`);
  if (dryRun) return;
  for (const u of updates) {
    try {
      await sql`
        UPDATE production_items
        SET platform_content_id = ${u.contentId}
        WHERE id = ${u.rowId} AND platform_content_id IS NULL
      `;
      derived++;
    } catch (err) {
      if (err?.code === "23505") {
        // Unique conflict — another row in the same account already owns this
        // id. That's exactly the duplicate Phase B will merge; leave the
        // platform_content_id NULL on this row so the merge query (which
        // groups by `derived_id`) can still pick it up.
        conflicts++;
      } else {
        throw err;
      }
    }
  }
  console.log(`  applied=${derived} unique_conflicts_left_for_phase_b=${conflicts}`);
}

// ─── Phase B — merge duplicates ──────────────────────────────────────────

// Tables that reference production_items.id. Each entry: child table + FK
// column. We run UPDATE child SET fk = winner WHERE fk = loser before
// deleting the loser. List enumerated from src/lib/db/schema.ts FK refs.
const CHILD_FKS = [
  ["transcripts", "production_item_id"],
  ["production_item_media", "production_item_id"],
  ["clip_ideas", "source_production_item_id"],
  ["clip_ideas", "accepted_production_item_id"],
  ["content_drafts", "production_item_id"],
  ["repurpose_triggers", "production_item_id"],
  ["cross_post_fit_verdicts", "source_item_id"],
  ["view_snapshots", "production_item_id"],
  ["cross_post_decisions", "source_item_id"],
  ["cross_post_decisions", "idea_item_id"],
  ["content_comments", "content_item_id"],
  ["content_events", "content_item_id"],
  ["notifications", "content_item_id"],
  // Self-refs on production_items
  ["production_items", "pillar_content_item_id"],
  ["production_items", "reposted_from_item_id"],
];

// Curation-quality score: higher = more "real" curated content.
function curationScore(r) {
  let s = 0;
  if (r.notion_id) s += 8;
  if (r.format) s += 4;
  if (r.pillar_content_item_id) s += 4;
  if (r.title && r.title !== "(No caption)") s += 2;
  if (r.editor_user_id) s += 1;
  if (r.producer_user_id) s += 1;
  if (r.source_type && r.source_type !== "original") s += 1;
  return s;
}

function maxNum(...xs) {
  let best = null;
  for (const x of xs) {
    if (x == null) continue;
    if (best == null || x > best) best = x;
  }
  return best;
}

async function phaseB() {
  console.log(`\n${dryRun ? "[dry-run]" : "[apply]"} Phase B — merge duplicate (account_id, derived_id) groups`);
  // Derive id for every row: prefer stored platform_content_id, else youtube_id,
  // else extract from URL. Group by (account_id, derived_id) and find groups
  // with >1 row.
  const rows = await sql`
    SELECT pi.id, pi.account_id, pi.platform_content_id, pi.youtube_id,
           pi.published_link, pi.post_type, pi.notion_id, pi.format,
           pi.pillar_content_item_id, pi.title, pi.editor_user_id,
           pi.producer_user_id, pi.source_type, pi.created_at,
           pi.views, pi.likes, pi.comments, pi.clicks, pi.leads,
           pi.deleted_at,
           a.platform, a.handle
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.deleted_at IS NULL
      AND pi.account_id IS NOT NULL
  `;
  const groups = new Map(); // key: `${account_id}|${derived_id}`
  for (const r of rows) {
    const derivedId =
      r.platform_content_id ??
      r.youtube_id ??
      extractContentId(r.post_type ?? r.platform, r.published_link);
    if (!derivedId) continue;
    const key = `${r.account_id}|${derivedId}`;
    if (!groups.has(key)) groups.set(key, { derivedId, rows: [] });
    groups.get(key).rows.push(r);
  }
  const dupGroups = [...groups.values()].filter((g) => g.rows.length > 1);
  console.log(`  total_groups=${groups.size} dup_groups=${dupGroups.length}`);

  let merged = 0;
  for (const g of dupGroups) {
    // Winner: highest curationScore, ties broken by oldest created_at.
    const sorted = [...g.rows].sort((a, b) => {
      const sa = curationScore(a);
      const sb = curationScore(b);
      if (sa !== sb) return sb - sa;
      return new Date(a.created_at) - new Date(b.created_at);
    });
    const winner = sorted[0];
    const losers = sorted.slice(1);
    const platform = winner.post_type ?? winner.platform;
    const canonicalUrl = canonicalPostUrl(platform, g.derivedId, winner.handle);

    // Compose the post-merge values for the winner: keep its own non-null
    // metadata, fall back to losers for any field the winner is missing,
    // and take the max of engagement counters across all rows.
    const fields = {
      platform_content_id: winner.platform_content_id ?? g.derivedId,
      published_link: canonicalUrl ?? winner.published_link,
      notion_id: winner.notion_id,
      format: winner.format,
      pillar_content_item_id: winner.pillar_content_item_id,
      title: winner.title,
      editor_user_id: winner.editor_user_id,
      producer_user_id: winner.producer_user_id,
      source_type: winner.source_type,
      views: winner.views,
      likes: winner.likes,
      comments: winner.comments,
      clicks: winner.clicks,
      leads: winner.leads,
    };
    for (const l of losers) {
      if (!fields.notion_id) fields.notion_id = l.notion_id;
      if (!fields.format) fields.format = l.format;
      if (!fields.pillar_content_item_id)
        fields.pillar_content_item_id = l.pillar_content_item_id;
      if (!fields.title || fields.title === "(No caption)") fields.title = l.title;
      // editor/producer are NOT NULL on every row — never overwrite
      fields.views = maxNum(fields.views, l.views);
      fields.likes = maxNum(fields.likes, l.likes);
      fields.comments = maxNum(fields.comments, l.comments);
      fields.clicks = maxNum(fields.clicks, l.clicks);
      fields.leads = maxNum(fields.leads, l.leads);
    }

    if (dryRun) {
      console.log(
        `  group=${g.derivedId} account=${winner.account_id} winner=${winner.id} losers=${losers
          .map((l) => l.id)
          .join(",")}`
      );
      continue;
    }

    await sql.begin(async (tx) => {
      // 1) Repoint every FK from any loser → winner so cascading deletes
      //    don't take useful children with them.
      for (const loser of losers) {
        for (const [table, col] of CHILD_FKS) {
          await tx.unsafe(
            `UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`,
            [winner.id, loser.id]
          );
        }
      }
      // 2) Delete losers BEFORE updating the winner. Otherwise the winner's
      //    UPDATE platform_content_id = ... would conflict with a loser
      //    that still owns the (account_id, platform_content_id) unique
      //    index in this same transaction.
      for (const loser of losers) {
        await tx`DELETE FROM production_items WHERE id = ${loser.id}`;
      }
      // 3) Apply the merged field set to the winner now that the unique
      //    key is free.
      await tx`
        UPDATE production_items SET
          platform_content_id = ${fields.platform_content_id},
          published_link = ${fields.published_link},
          notion_id = ${fields.notion_id},
          format = ${fields.format},
          pillar_content_item_id = ${fields.pillar_content_item_id},
          title = ${fields.title},
          editor_user_id = ${fields.editor_user_id},
          producer_user_id = ${fields.producer_user_id},
          source_type = ${fields.source_type},
          views = ${fields.views},
          likes = ${fields.likes},
          comments = ${fields.comments},
          clicks = ${fields.clicks},
          leads = ${fields.leads},
          updated_at = now()
        WHERE id = ${winner.id}
      `;
    });
    merged++;
  }
  console.log(`  merged=${merged} (was dry-run? ${dryRun})`);
}

// ─── Phase C — delete Threads replies ────────────────────────────────────

async function phaseC() {
  if (skipReplies) {
    console.log(`\nPhase C — skipped (--skip-replies)`);
    return;
  }
  console.log(`\n${dryRun ? "[dry-run]" : "[apply]"} Phase C — delete Threads replies`);
  // The is_reply column ships in drizzle/0051. If migrations haven't been
  // applied yet (local dev DB before `npm run db:migrate`), bail out cleanly
  // rather than crashing the whole run.
  const [{ exists: hasColumn }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'production_items' AND column_name = 'is_reply'
    ) AS exists
  `;
  if (!hasColumn) {
    console.log(`  is_reply column not present — run \`npm run db:migrate\` first, then re-run with --skip-replies omitted`);
    return;
  }
  const replies = await sql`
    SELECT pi.id, pi.title
    FROM production_items pi
    WHERE pi.is_reply = true AND pi.deleted_at IS NULL
  `;
  console.log(`  reply_rows=${replies.length}`);
  if (dryRun || replies.length === 0) return;
  // Replies with FK references would CASCADE on delete; in practice replies
  // shouldn't have transcripts/clip_ideas/etc. attached, but null them out
  // first to be safe rather than risk cascading useful data.
  for (const r of replies) {
    await sql`DELETE FROM production_items WHERE id = ${r.id}`;
  }
  console.log(`  deleted=${replies.length}`);
}

// ─── Run ─────────────────────────────────────────────────────────────────

try {
  console.log(`Cleanup duplicates ${dryRun ? "(dry-run)" : "(apply)"}`);
  await phaseA();
  await phaseB();
  await phaseC();
  console.log("\nDone.");
  if (dryRun) {
    console.log("Pass --apply to write changes.");
  }
} catch (err) {
  console.error("cleanup failed:", err);
  process.exit(1);
} finally {
  await sql.end();
}
