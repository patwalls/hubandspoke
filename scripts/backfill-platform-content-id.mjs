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

// Fallback used when accounts.platform is null (orphan rows, legacy data).
// Mirrors src/lib/platform-url.ts's inferPlatformFromUrl.
function inferPlatformFromUrl(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be")
    return "youtube";
  if (host === "instagram.com") return "instagram";
  if (host === "threads.net" || host === "threads.com") return "threads";
  if (host === "x.com" || host === "twitter.com") return "x";
  if (host === "tiktok.com" || host === "vm.tiktok.com") return "tiktok";
  if (host === "linkedin.com") return "linkedin";
  return null;
}

function deriveContentId(platform, youtubeId, publishedLink) {
  if (youtubeId) return youtubeId;
  if (!publishedLink) return null;
  // Fall back to URL-host inference when the linked account's platform
  // wasn't usable. Catches rows that live without a linked account row
  // (legacy / drafted-then-orphaned).
  const effective =
    platform && platform !== "unknown"
      ? platform
      : inferPlatformFromUrl(publishedLink);
  switch (effective) {
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

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
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

  // Pre-flight: build an index of every existing (content_id) so we know
  // which derivations would collide with a row that already owns the id.
  // Surfaced in the dry-run report so the user sees the duplicate count
  // before applying anything.
  const existing = await sql`
    SELECT id, account_id, platform_content_id, published_link
      FROM production_items
     WHERE platform_content_id IS NOT NULL
       AND deleted_at IS NULL
  `;
  const ownersByContentId = new Map();
  for (const e of existing) {
    if (!ownersByContentId.has(e.platform_content_id)) {
      ownersByContentId.set(e.platform_content_id, []);
    }
    ownersByContentId.get(e.platform_content_id).push(e);
  }

  const updates = [];
  const conflicts = []; // { row, contentId, owners }
  const missByPlatform = new Map();
  for (const r of rows) {
    const platform = r.platform ?? "unknown";
    const id = deriveContentId(platform, r.youtube_id, r.published_link);
    if (!id) {
      missByPlatform.set(platform, (missByPlatform.get(platform) ?? 0) + 1);
      continue;
    }
    const owners = ownersByContentId.get(id);
    if (owners && owners.length > 0) {
      conflicts.push({ row: r, contentId: id, owners });
      continue;
    }
    updates.push({ id: r.id, contentId: id });
    // Reserve so two candidates in the same run don't both win.
    ownersByContentId.set(id, [{ id: r.id }]);
  }

  console.log(`Derivable + safe to write: ${updates.length}`);
  console.log(`Pre-existing duplicates (manual triage): ${conflicts.length}`);
  if (missByPlatform.size > 0) {
    console.log("Couldn't derive id (left as NULL):");
    for (const [p, n] of missByPlatform) {
      console.log(`  ${p}: ${n}`);
    }
  }

  if (conflicts.length > 0) {
    console.log(`\nDuplicates that would collide:`);
    for (const c of conflicts.slice(0, 50)) {
      console.log(
        `  ✗ ${c.row.id} → content_id=${c.contentId} (already on ${c.owners.map((o) => o.id).join(", ")})  ${truncate(c.row.published_link, 70)}`
      );
    }
    if (conflicts.length > 50) {
      console.log(`  … and ${conflicts.length - 50} more`);
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
  let runtimeConflicts = 0;
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
      // same account share a derived id — surface it but keep going. Should
      // be rare since we pre-detect via ownersByContentId; this catches any
      // race that slipped past the pre-flight check.
      if (err?.code === "23505") {
        runtimeConflicts++;
        console.warn(
          `CONFLICT item=${u.id} derived=${u.contentId}: ${err.message}`
        );
      } else {
        throw err;
      }
    }
  }

  console.log(`\nApplied: ${applied}`);
  if (runtimeConflicts > 0) {
    console.log(
      `Skipped ${runtimeConflicts} rows where another item in the same account already owned the derived id — inspect and reconcile manually.`
    );
  }
} catch (err) {
  console.error("backfill failed:", err);
  process.exit(1);
} finally {
  await sql.end();
}
