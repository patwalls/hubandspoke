#!/usr/bin/env node
/**
 * Backfill: create a sibling `production_items` row for every existing
 * `clip_ideas` row that doesn't have one yet, so historical un-triaged clip
 * ideas appear in `/[brand]/queue/clip` alongside reposts and cross-posts.
 *
 * Idempotent — only inserts for clip_ideas where:
 *   - status = 'suggested'                    (skip already-killed/-assigned)
 *   - accepted_production_item_id IS NULL     (skip ones already linked)
 *
 * Producer/editor are stamped with the actor user id (CLI flag, env var, or
 * auto-picked oldest admin). Both columns are NOT NULL on production_items.
 * Notifications don't fire on INSERT (only on PUT diff in
 * /api/production-items), so this is silent.
 *
 * Usage:
 *   # Local:
 *   node --env-file=.env.local scripts/backfill-clip-idea-production-items.mjs
 *
 *   # Heroku (auto-runs in release phase via Procfile):
 *   heroku run --app=hubandspoke node scripts/backfill-clip-idea-production-items.mjs
 *
 * Flags:
 *   --user-id <uuid>     Stamp producer/editor with this user (overrides auto-pick)
 *   --dry-run            Print what would be inserted, don't write
 *   --apply-if-pending   Release-phase mode: silently no-op when nothing to backfill
 */
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const PROMOTED_CLIP_FORMAT = "Repackage section with hook";

function parseArgs() {
  const args = process.argv.slice(2);
  let userId = process.env.PAT_USER_ID || null;
  let dryRun = false;
  let applyIfPending = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user-id" && args[i + 1]) {
      userId = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--apply-if-pending") {
      applyIfPending = true;
    }
  }
  return { userId, dryRun, applyIfPending };
}

function fmtTs(sec) {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildContentBody(row) {
  const startSec = Number(row.start_sec);
  const endSec = Number(row.end_sec);
  const duration = Math.max(0, Math.round(endSec - startSec));
  const range = `${fmtTs(startSec)}–${fmtTs(endSec)} (${duration}s)`;
  return [
    `Source: ${row.source_title ?? "(untitled)"}`,
    `Timestamp: ${range}`,
    "",
    `Angle: ${row.angle}`,
    "",
    `Why: ${row.rationale}`,
  ].join("\n");
}

async function pickFallbackAdmin(sql) {
  const rows = await sql`
    SELECT id FROM users
    WHERE role = 'admin'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// Resolve the brand's Instagram account once and cache. Reels are the default
// surface for clip-idea promotions. Returns null if the brand has no Instagram
// account — caller leaves account_id null and the row still inserts.
const igAccountCache = new Map();
async function getInstagramAccountId(sql, brandSlug) {
  if (igAccountCache.has(brandSlug)) return igAccountCache.get(brandSlug);
  const rows = await sql`
    SELECT a.id
    FROM accounts a
    INNER JOIN brands b ON b.id = a.brand_id
    WHERE b.slug = ${brandSlug}
      AND a.platform = 'instagram'
      AND a.deleted_at IS NULL
    LIMIT 2
  `;
  const id = rows.length === 1 ? rows[0].id : null;
  igAccountCache.set(brandSlug, id);
  return id;
}

// Repair pass: any pre-existing clip prod_item that was inserted by an earlier
// run of this script (or by the generate route) before all the channel-wiring
// landed. Two repairs:
//   (a) account_id / post_type / platform — the Instagram-Reel default
//   (b) pillar_content_item_id — copied from clip_ideas.source_production_item_id
// Single bulk UPDATE for (b) since it doesn't need per-brand resolution.
// Then a per-row loop for (a) which does. Idempotent — skips rows already set.
async function repairExistingClipProductionItems(sql, dryRun) {
  // (b) Pillar reference — bulk UPDATE.
  if (!dryRun) {
    const pillar = await sql`
      UPDATE production_items pi
      SET pillar_content_item_id = ci.source_production_item_id,
          updated_at = NOW()
      FROM clip_ideas ci
      WHERE pi.source_clip_idea_id = ci.id
        AND pi.source_type = 'clip'
        AND pi.deleted_at IS NULL
        AND pi.pillar_content_item_id IS NULL
        AND ci.source_production_item_id IS NOT NULL
      RETURNING pi.id
    `;
    if (pillar.length > 0) {
      console.log(`🔧 Stamped pillar_content_item_id on ${pillar.length} clip production_items`);
    }
  }

  // (a) Channel wiring — needs per-brand Instagram account lookup.
  const rows = await sql`
    SELECT id, brand
    FROM production_items
    WHERE source_type = 'clip'
      AND deleted_at IS NULL
      AND (account_id IS NULL OR post_type IS NULL OR platform IS NULL OR platform::text = '[]')
  `;
  if (rows.length === 0) return 0;
  let patched = 0;
  for (const row of rows) {
    const accountId = await getInstagramAccountId(sql, row.brand);
    if (dryRun) {
      console.log(`   [dry] repair ${row.id} brand=${row.brand} account=${accountId}`);
      patched++;
      continue;
    }
    await sql`
      UPDATE production_items
      SET account_id = COALESCE(account_id, ${accountId}),
          post_type = COALESCE(post_type, 'instagram_reel'),
          platform = ${sql.json(["Instagram Reel"])}
      WHERE id = ${row.id}
    `;
    patched++;
  }
  return patched;
}

async function main() {
  const { userId: cliUserId, dryRun, applyIfPending } = parseArgs();

  const sql = postgres(process.env.DATABASE_URL, {
    ssl: process.env.DATABASE_SSL === "off" ? false : "require",
  });

  // Repair pass first — patch any prior clip prod_items missing the channel
  // wiring (account_id / post_type / platform). Cheap query when nothing's
  // pending; effectively free on subsequent release runs.
  const repaired = await repairExistingClipProductionItems(sql, dryRun);
  if (repaired > 0) {
    console.log(`🔧 Repaired ${repaired} existing clip production_items (set account_id / post_type / platform)`);
  }

  // Fast path for release phase: if there's nothing to do, exit cleanly
  // without picking an admin, opening transactions, or making noise.
  const [{ count: pendingCount }] = await sql`
    SELECT COUNT(*)::int AS count
    FROM clip_ideas
    WHERE status = 'suggested'
      AND accepted_production_item_id IS NULL
  `;
  if (pendingCount === 0) {
    if (!applyIfPending) {
      console.log("✅ Nothing to backfill — every suggested clip_idea already has a production_item.");
    }
    await sql.end();
    return;
  }

  let userId = cliUserId;
  if (!userId) {
    userId = await pickFallbackAdmin(sql);
    if (!userId) {
      console.error(
        "❌ No admin user found. Pass --user-id <uuid> or set PAT_USER_ID.",
      );
      await sql.end();
      process.exit(1);
    }
    console.log(`ℹ️  No --user-id given; using oldest admin (${userId}).`);
  }

  console.log(
    `🔄 Backfilling production_items for ${pendingCount} clip_ideas (actor=${userId}${dryRun ? ", dry-run" : ""})`,
  );

  const candidates = await sql`
    SELECT
      ci.id,
      ci.source_production_item_id,
      ci.start_sec,
      ci.end_sec,
      ci.hook,
      ci.angle,
      ci.rationale,
      pi.title  AS source_title,
      pi.brand  AS source_brand
    FROM clip_ideas ci
    LEFT JOIN production_items pi ON pi.id = ci.source_production_item_id
    WHERE ci.status = 'suggested'
      AND ci.accepted_production_item_id IS NULL
    ORDER BY ci.created_at ASC
  `;

  let inserted = 0;
  let failed = 0;
  for (const row of candidates) {
    const body = buildContentBody(row);
    const brand = row.source_brand ?? "starter-story";

    if (dryRun) {
      console.log(`   [dry] ${row.id}  ${row.hook?.slice(0, 60) ?? ""}`);
      inserted++;
      continue;
    }

    const accountId = await getInstagramAccountId(sql, brand);
    try {
      const created = await sql`
        INSERT INTO production_items (
          title, status, platform, post_type, account_id,
          format, brand, content_body,
          pillar_content_item_id, source_type, source_clip_idea_id,
          producer_user_id, editor_user_id,
          hook, hook_source, hook_extracted_at
        )
        VALUES (
          ${row.hook},
          'Idea',
          ${sql.json(["Instagram Reel"])},
          'instagram_reel',
          ${accountId},
          ${PROMOTED_CLIP_FORMAT},
          ${brand},
          ${body},
          ${row.source_production_item_id},
          'clip',
          ${row.id},
          ${userId},
          ${userId},
          ${row.hook},
          'clip_idea',
          NOW()
        )
        RETURNING id
      `;
      const newId = created[0].id;
      await sql`
        UPDATE clip_ideas SET accepted_production_item_id = ${newId}
        WHERE id = ${row.id}
      `;
      inserted++;
    } catch (err) {
      failed++;
      console.error(`   ❌ ${row.id}: ${err.message}`);
    }
  }

  console.log(`✅ Inserted ${inserted}, failed ${failed}`);
  await sql.end();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
