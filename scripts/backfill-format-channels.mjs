/**
 * Backfill format_channels rows from the legacy formats.channels jsonb[]
 * column. Mirrors the channel-string → (account, post_type) resolver used in
 * backfill-accounts.mjs so the same mapping rules apply on both sides of the
 * relation.
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 * Re-runnable: rows are deduped via the uniq_format_channels_format_account_post_type
 * index, so reapplying is a no-op once everything's in place.
 *
 *   node --env-file=.env.local scripts/backfill-format-channels.mjs           # dry
 *   node --env-file=.env.local scripts/backfill-format-channels.mjs --apply   # commit
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 4,
});

// Same resolver shape as scripts/backfill-accounts.mjs. Keep these two in sync
// — the mapping is the contract for what an old channel string means.
function resolveAccount(rawChannel, brandSlug) {
  const s = (rawChannel ?? "").trim();
  const lower = s.toLowerCase();

  if (brandSlug === "matg") {
    if (lower === "youtube") return { platform: "youtube", handle: "matgpod", postType: "youtube_long" };
    if (lower === "youtube shorts") return { platform: "youtube", handle: "matgpod", postType: "youtube_shorts" };
    if (lower === "youtube community") return { platform: "youtube", handle: "matgpod", postType: "youtube_community" };
    if (lower === "instagram reel") return { platform: "instagram", handle: "matgpod", postType: "instagram_reel" };
    if (lower === "instagram post") return { platform: "instagram", handle: "matgpod", postType: "instagram_post" };
    if (lower === "instagram story") return { platform: "instagram", handle: "matgpod", postType: "instagram_story" };
    if (lower === "x" || lower === "twitter") return { platform: "x", handle: "matgpod", postType: "x" };
    if (lower === "linkedin") return { platform: "linkedin", handle: "hubspot-marketing-against-the-grain", postType: "linkedin" };
    if (lower === "tiktok") return { platform: "tiktok", handle: "matgpod", postType: "tiktok" };
    if (lower === "threads") return { platform: "threads", handle: "matgpod", postType: "threads" };
    return null;
  }

  // starter-story (default)
  if (lower === "youtube (ss)" || lower === "youtube") {
    return { platform: "youtube", handle: "starterstory", postType: "youtube_long" };
  }
  if (lower === "youtube (ss build)") {
    return { platform: "youtube", handle: "starterstorybuild", postType: "youtube_long" };
  }
  if (lower === "youtube shorts") {
    return { platform: "youtube", handle: "starterstory", postType: "youtube_shorts" };
  }
  if (lower === "youtube community" || lower === "youtube (pinned comment)") {
    return { platform: "youtube", handle: "starterstory", postType: "youtube_community" };
  }

  if (lower === "x" || lower === "twitter" || lower.startsWith("x (") || lower.startsWith("twitter (")) {
    if (lower.includes("pat walls") || lower.includes("(pat)")) {
      return { platform: "x", handle: "thepatwalls", postType: "x" };
    }
    if (lower.includes("starter story")) {
      return { platform: "x", handle: "starterstory", postType: "x" };
    }
    // Bare "X" with no published_link context (formats don't have one) —
    // default to Pat's handle, matching the items backfill default.
    return { platform: "x", handle: "thepatwalls", postType: "x" };
  }

  if (lower === "instagram reel") return { platform: "instagram", handle: "starter_story", postType: "instagram_reel" };
  if (lower === "instagram post") return { platform: "instagram", handle: "starter_story", postType: "instagram_post" };
  if (lower === "instagram story") return { platform: "instagram", handle: "starter_story", postType: "instagram_story" };

  if (lower === "linkedin") return { platform: "linkedin", handle: "patrickwalls", postType: "linkedin" };
  if (lower === "tiktok") return { platform: "tiktok", handle: "starterstory", postType: "tiktok" };
  if (lower === "threads") return { platform: "threads", handle: "starter_story", postType: "threads" };
  if (lower === "newsletter") return { platform: "newsletter", handle: "starter-story", postType: "newsletter" };

  if (lower === "ss case study") return { platform: "other", handle: "ss-case-study", postType: null };
  if (lower === "ss database") return { platform: "other", handle: "ss-database", postType: null };
  if (lower === "paid ad") return { platform: "other", handle: "paid-ad", postType: null };

  return null;
}

console.log(`Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"}`);

try {
  const accountRows = await sql`
    SELECT a.id, a.platform, lower(a.handle) AS handle, b.slug AS brand_slug
    FROM accounts a
    JOIN brands b ON b.id = a.brand_id
  `;
  const acctLookup = new Map();
  for (const r of accountRows) {
    acctLookup.set(`${r.brand_slug}|${r.platform}|${r.handle}`, r.id);
  }
  console.log(`Loaded ${acctLookup.size} accounts.`);

  const formats = await sql`
    SELECT id, brand, name, channels FROM formats
  `;
  console.log(`Found ${formats.length} formats.`);

  const unresolvedByChannel = new Map();
  let totalRows = 0;
  let formatsWithChannels = 0;

  for (const fmt of formats) {
    // formats.channels is jsonb but some legacy rows store a stringified
    // JSON array (Notion sync bug pattern — same as the platform column on
    // production_items). Parse if needed.
    let channels = fmt.channels;
    if (typeof channels === "string") {
      try {
        const parsed = JSON.parse(channels);
        channels = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        channels = [channels];
      }
    }
    if (!Array.isArray(channels)) channels = [];
    if (channels.length === 0) continue;
    formatsWithChannels++;
    const brandSlug = fmt.brand ?? "starter-story";

    for (const raw of channels) {
      const res = resolveAccount(raw, brandSlug);
      if (!res) {
        unresolvedByChannel.set(raw, (unresolvedByChannel.get(raw) ?? 0) + 1);
        continue;
      }
      const key = `${brandSlug}|${res.platform}|${res.handle.toLowerCase()}`;
      const accountId = acctLookup.get(key);
      if (!accountId) {
        console.warn(`  no account for ${key} (format ${fmt.name})`);
        continue;
      }

      if (!dryRun) {
        await sql`
          INSERT INTO format_channels (format_id, account_id, post_type)
          VALUES (${fmt.id}, ${accountId}, ${res.postType})
          ON CONFLICT DO NOTHING
        `;
      }
      totalRows++;
    }
  }

  console.log(
    `\n[${dryRun ? "dry" : "applied"}] formats_with_channels=${formatsWithChannels} rows=${totalRows}`
  );
  if (unresolvedByChannel.size) {
    console.log("Unresolved channel strings (skipped):");
    for (const [raw, n] of unresolvedByChannel) {
      console.log(`  ${JSON.stringify(raw)} × ${n}`);
    }
  }

  if (dryRun) {
    console.log("\nDry run — no writes. Re-run with --apply to execute.");
  }

  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error("Backfill failed:", err);
  try { await sql.end({ timeout: 5 }); } catch {}
  process.exit(1);
}
