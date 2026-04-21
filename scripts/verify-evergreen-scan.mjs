/**
 * One-shot verification of the reworked evergreen scan.
 *
 * Does NOT call the classifier or insert repost rows — this only reads from
 * the DB to confirm the new queries work and to preview what Phase A and
 * Phase B would see with real data.
 *
 * Usage:
 *   node --env-file=.env.local scripts/verify-evergreen-scan.mjs
 */
import postgres from "postgres";

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

const MIN_VIEWS = 10_000;
const MIN_REPOST_SPACING_DAYS = 30;
const PENDING_QUEUE_TARGET = 10;
const CANDIDATE_POOL_SIZE = 80;
const MAX_PER_PLATFORM = Math.ceil(PENDING_QUEUE_TARGET * 0.4);

const QUOTAS = [
  { bucket: "twitter", channels: ["Twitter", "Twitter (Pat Walls)"], limit: 8, minAgeDays: 365 },
  { bucket: "instagram", channels: ["Instagram Reel", "Instagram Post"], limit: 6, minAgeDays: 90 },
  { bucket: "linkedin", channels: ["LinkedIn"], limit: 2, minAgeDays: 180 },
  { bucket: "threads", channels: ["Threads"], limit: 2, minAgeDays: 180 },
  { bucket: "youtube", channels: ["YouTube Community", "YouTube Shorts"], limit: 2, minAgeDays: 180 },
];

async function main() {
  console.log("=== Phase A preview: what would each bucket classify? ===\n");
  for (const q of QUOTAS) {
    const rows = await sql`
      SELECT id, title, platform, views,
             content_body IS NOT NULL AND content_body <> '' AS has_body,
             content_media_url IS NOT NULL AS has_media
      FROM production_items
      WHERE source_type = 'original'
        AND status = 'Published'
        AND is_evergreen IS NULL
        AND views > ${MIN_VIEWS}
        AND published_date < (now() - interval '${sql.unsafe(String(q.minAgeDays))} days')::date
        AND platform ?| ${q.channels}::text[]
      ORDER BY views DESC
      LIMIT ${q.limit}
    `;
    console.log(
      `  ${q.bucket.padEnd(10)} (limit ${q.limit}): ${rows.length} item${
        rows.length === 1 ? "" : "s"
      }`
    );
    for (const r of rows) {
      console.log(
        `    - [${r.platform.join(",")}] views=${r.views} has_body=${r.has_body} has_media=${r.has_media} :: ${r.title?.slice(0, 70)}`
      );
    }
  }

  console.log("\n=== Phase A': re-classification candidates ===");
  const reclassify = await sql`
    SELECT id, title, platform, views, evergreen_reasoning
    FROM production_items
    WHERE source_type = 'original'
      AND status = 'Published'
      AND is_evergreen = false
      AND views > ${MIN_VIEWS}
      AND content_body IS NOT NULL AND content_body <> ''
      AND content_body_fetched_at IS NOT NULL
      AND evergreen_evaluated_at IS NOT NULL
      AND content_body_fetched_at > evergreen_evaluated_at
    ORDER BY views DESC
    LIMIT 5
  `;
  console.log(`  ${reclassify.length} item${reclassify.length === 1 ? "" : "s"} would be re-classified`);
  for (const r of reclassify) {
    console.log(
      `    - [${r.platform.join(",")}] views=${r.views} :: ${r.title?.slice(0, 70)}`
    );
  }

  console.log("\n=== Phase B preview ===");
  const pending = await sql`
    SELECT platform FROM production_items
    WHERE source_type = 'repost' AND status = 'Idea'
  `;
  console.log(`  Pending reposts: ${pending.length} (target=${PENDING_QUEUE_TARGET})`);
  const perChannel = new Map();
  for (const p of pending) {
    for (const ch of p.platform ?? []) {
      perChannel.set(ch, (perChannel.get(ch) ?? 0) + 1);
    }
  }
  console.log(`  Pending per-channel (cap=${MAX_PER_PLATFORM}):`);
  for (const [ch, n] of perChannel) {
    const flag = n >= MAX_PER_PLATFORM ? " ← CAPPED" : "";
    console.log(`    ${ch}: ${n}${flag}`);
  }

  const slots = Math.max(0, PENDING_QUEUE_TARGET - pending.length);
  console.log(`  Open slots: ${slots}`);

  const pool = await sql`
    SELECT id, title, platform, views,
           content_body IS NOT NULL AND content_body <> '' AS has_body,
           content_media_url IS NOT NULL AS has_media,
           evergreen_reasoning
    FROM production_items
    WHERE source_type = 'original'
      AND is_evergreen = true
      AND status = 'Published'
    ORDER BY views DESC
    LIMIT ${CANDIDATE_POOL_SIZE}
  `;
  console.log(`  Evergreen pool size: ${pool.length}`);

  const originalIds = pool.map((p) => p.id);
  const history =
    originalIds.length === 0
      ? []
      : await sql`
          SELECT reposted_from_item_id, platform, status, created_at
          FROM production_items
          WHERE source_type = 'repost'
            AND reposted_from_item_id = ANY(${originalIds}::uuid[])
            AND (
              status = 'Killed'
              OR created_at > now() - interval '${sql.unsafe(String(MIN_REPOST_SPACING_DAYS))} days'
            )
        `;
  const blocked = new Set();
  for (const h of history) {
    for (const ch of h.platform ?? []) {
      blocked.add(`${h.reposted_from_item_id}::${ch}`);
    }
  }
  console.log(`  Blocked (original,channel) pairs from history: ${blocked.size}`);

  console.log(`\n  Simulated selection (up to ${slots} slots):`);
  const counts = new Map(perChannel);
  let picked = 0;
  const picks = [];
  for (const original of pool) {
    if (picked >= slots) break;
    const channels = (original.platform ?? []).filter(
      (ch) => !["YouTube", "YouTube (SS)", "YouTube (SS Build)"].includes(ch)
    );
    for (const ch of channels) {
      if (blocked.has(`${original.id}::${ch}`)) continue;
      if ((counts.get(ch) ?? 0) >= MAX_PER_PLATFORM) continue;
      if (
        ch.startsWith("Instagram") &&
        !original.has_body &&
        !original.has_media
      ) {
        continue;
      }
      picks.push({ ch, title: original.title, views: original.views });
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
      blocked.add(`${original.id}::${ch}`);
      picked++;
      break;
    }
  }
  for (const p of picks) {
    console.log(`    + [${p.ch}] views=${p.views} :: ${p.title?.slice(0, 70)}`);
  }
  console.log(`  Would create: ${picks.length} repost idea${picks.length === 1 ? "" : "s"}`);

  const channelMix = new Map();
  for (const p of picks) {
    channelMix.set(p.ch, (channelMix.get(p.ch) ?? 0) + 1);
  }
  console.log("  Channel mix of new picks:");
  for (const [ch, n] of channelMix) {
    console.log(`    ${ch}: ${n}`);
  }

  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
