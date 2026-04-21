/**
 * One-shot cross-post scan with a configurable recency window.
 *
 * The daily cron (src/lib/services/cross-post-scan.ts) uses a 180-day window.
 * Use this script when you want to run a catch-up pass at a different window
 * (e.g., only recent content).
 *
 * Usage:
 *   # dry-run scan for rules active on starter-story over last 30 days
 *   DATABASE_URL="$(heroku config:get DATABASE_URL --app=hubandspoke)" \
 *     node scripts/run-cross-post-scan.mjs --days=30
 *
 *   # apply (inserts Idea rows)
 *   DATABASE_URL="..." node scripts/run-cross-post-scan.mjs --days=30 --apply
 *
 * Dedup: skips any (source_item, target_platform) pair that already has a
 * cross_post row pointing at it, and skips target platforms already on the
 * source's own platform list.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;
const daysArg = args.find((a) => a.startsWith("--days="))?.split("=")[1];
const days = daysArg ? Number(daysArg) : 30;

if (!Number.isFinite(days) || days < 1) {
  console.error("--days must be a positive integer");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: connectionString.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 1,
});

// Mirrors isNotionAuthoritative from src/lib/platform.ts — long-form YouTube
// pillars are Notion-authoritative and we don't create cross-posts targeting
// them.
const NOTION_AUTHORITATIVE = new Set([
  "YouTube",
  "YouTube (SS)",
  "YouTube (SS Build)",
]);

async function main() {
  console.log(
    `Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"} | days=${days}\n`
  );

  const rules = await sql`
    SELECT id, brand, source_platform, view_threshold, target_platform
    FROM cross_post_rules
    WHERE active = true
  `;

  if (rules.length === 0) {
    console.log("No active rules.");
    await sql.end();
    return;
  }
  console.log(`${rules.length} active rules to evaluate:\n`);

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalCandidates = 0;

  for (const rule of rules) {
    if (NOTION_AUTHORITATIVE.has(rule.target_platform)) {
      console.log(
        `[skip rule] ${rule.source_platform} ≥ ${rule.view_threshold} → ${rule.target_platform} (target is Notion-authoritative)`
      );
      continue;
    }

    const candidates = await sql`
      SELECT id, title, thumbnail, brand, platform, views, published_date,
             format, pillar_content_notion_id, pillar_content_item_id
      FROM production_items
      WHERE brand = ${rule.brand}
        AND source_type = 'original'
        AND status = 'Published'
        AND views >= ${rule.view_threshold}
        AND platform ? ${rule.source_platform}
        AND published_date >= (now() - interval '${sql.unsafe(String(days))} days')::date
    `;

    let created = 0;
    let skipped = 0;
    for (const c of candidates) {
      totalCandidates++;

      // Don't cross-post back to a platform the original already covers.
      const existingPlatforms = c.platform ?? [];
      if (existingPlatforms.includes(rule.target_platform)) {
        skipped++;
        continue;
      }

      // Dedup: already have a cross_post row for this (source, target) pair?
      const existing = await sql`
        SELECT id FROM production_items
        WHERE source_type = 'cross_post'
          AND reposted_from_item_id = ${c.id}
          AND platform ? ${rule.target_platform}
        LIMIT 1
      `;
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      if (!dryRun) {
        await sql`
          INSERT INTO production_items (
            brand, title, thumbnail, status, platform,
            source_type, reposted_from_item_id,
            format, pillar_content_notion_id, pillar_content_item_id
          ) VALUES (
            ${c.brand}, ${c.title}, ${c.thumbnail}, 'Idea',
            ${JSON.stringify([rule.target_platform])}::jsonb,
            'cross_post', ${c.id},
            ${c.format}, ${c.pillar_content_notion_id}, ${c.pillar_content_item_id}
          )
        `;
      }
      created++;
    }

    totalCreated += created;
    totalSkipped += skipped;
    console.log(
      `  ${rule.source_platform} ≥ ${rule.view_threshold.toLocaleString()} → ${rule.target_platform}: ` +
        `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}, ` +
        `${dryRun ? "would create" : "created"} ${created}, skipped ${skipped}`
    );
  }

  console.log(
    `\n${dryRun ? "Would create" : "Created"} ${totalCreated} new cross-post Idea row${
      totalCreated === 1 ? "" : "s"
    } from ${totalCandidates} candidates (${totalSkipped} skipped as dupes/self-matches).`
  );
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
