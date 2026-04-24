/**
 * One-shot backfill of production_items.platform_content_id for existing
 * rows. The column was added alongside the new per-account content sync
 * (see src/lib/services/account-content-sync.ts) and is the dedup key for
 * all future upserts.
 *
 * Strategy (per platform):
 *   - YouTube   → copy youtube_id verbatim
 *   - X         → extract `status/:id` from published_link
 *   - Instagram → extract `/p/:code` or `/reel/:code` from published_link
 *   - TikTok    → extract `/video/:id` from published_link
 *   - LinkedIn  → extract the `activity-:urn-:id` or :id from the URL
 *   - Threads   → extract `/post/:code` from published_link
 *
 * Rows we couldn't derive an id for are left untouched (NULL stays NULL;
 * the partial unique index ignores them). Safe to re-run — updates are
 * idempotent and guarded by `platform_content_id IS NULL`.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-platform-content-id.mjs         # dry-run
 *   node --env-file=.env.local scripts/backfill-platform-content-id.mjs --apply
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const sql = postgres(databaseUrl, { max: 1, ssl, prepare: false });

// ─── Extractors ──────────────────────────────────────────────────────────

function extractTweetId(url) {
  const m = url.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

function extractInstagramCode(url) {
  const m = url.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractTiktokId(url) {
  const m = url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function extractThreadsCode(url) {
  const m = url.match(/\/post\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractLinkedInId(url) {
  // LinkedIn posts look like:
  //   linkedin.com/posts/<handle>_<slug>-activity-7134..._<noise>
  //   linkedin.com/feed/update/urn:li:activity:7134...
  const activity = url.match(/activity[:-](\d+)/);
  if (activity) return activity[1];
  const urnMatch = url.match(/urn:li:(?:activity|share):(\d+)/);
  if (urnMatch) return urnMatch[1];
  return null;
}

function deriveContentId(platform, youtubeId, publishedLink) {
  if (youtubeId) return youtubeId;
  if (!publishedLink) return null;
  switch (platform) {
    case "youtube":
      // Fall back to yt video id parse if youtube_id wasn't populated yet.
      {
        const m = publishedLink.match(
          /(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([\w-]{11})/
        );
        return m ? m[1] : null;
      }
    case "x":
      return extractTweetId(publishedLink);
    case "instagram":
      return extractInstagramCode(publishedLink);
    case "tiktok":
      return extractTiktokId(publishedLink);
    case "threads":
      return extractThreadsCode(publishedLink);
    case "linkedin":
      return extractLinkedInId(publishedLink);
    default:
      return null;
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────

try {
  const rows = await sql`
    SELECT pi.id,
           pi.youtube_id,
           pi.published_link,
           a.platform
    FROM production_items pi
    LEFT JOIN accounts a ON a.id = pi.account_id
    WHERE pi.platform_content_id IS NULL
      AND pi.deleted_at IS NULL
  `;
  console.log(`Scanning ${rows.length} candidate rows…`);

  const updates = [];
  const missByPlatform = new Map();
  for (const r of rows) {
    const platform = r.platform ?? "unknown";
    const id = deriveContentId(platform, r.youtube_id, r.published_link);
    if (id) {
      updates.push({ id: r.id, contentId: id });
    } else {
      missByPlatform.set(platform, (missByPlatform.get(platform) ?? 0) + 1);
    }
  }

  console.log(`Derivable: ${updates.length}`);
  if (missByPlatform.size > 0) {
    console.log("Couldn't derive id (left as NULL):");
    for (const [p, n] of missByPlatform) {
      console.log(`  ${p}: ${n}`);
    }
  }

  if (dryRun) {
    console.log(
      "\nDry run — pass --apply to write. Sample derived ids:",
      updates.slice(0, 5)
    );
    process.exit(0);
  }

  let applied = 0;
  let conflicts = 0;
  for (const u of updates) {
    try {
      await sql`
        UPDATE production_items
        SET platform_content_id = ${u.contentId}
        WHERE id = ${u.id}
          AND platform_content_id IS NULL
      `;
      applied++;
    } catch (err) {
      // A conflict on (account_id, platform_content_id) means two rows in the
      // same account share a derived id — surface it but keep going.
      if (err?.code === "23505") {
        conflicts++;
        console.warn(
          `CONFLICT item=${u.id} derived=${u.contentId}: ${err.message}`
        );
      } else {
        throw err;
      }
    }
  }

  console.log(`\nApplied: ${applied}`);
  if (conflicts > 0) {
    console.log(
      `Skipped ${conflicts} rows where another item in the same account already owned the derived id — inspect and reconcile manually.`
    );
  }
} catch (err) {
  console.error("backfill failed:", err);
  process.exit(1);
} finally {
  await sql.end();
}
