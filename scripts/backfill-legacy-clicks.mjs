/**
 * One-time backfill: seed historical click counts into go.starterstory.com
 * links so the dashboard can read ALL clicks uniformly from the go API.
 *
 * Clicks used to live on `production_items.clicks` (synced from Notion, which
 * itself came from PostHog by utm_campaign). Now the `sync-link-metrics` job
 * sources clicks from each post's go short link. Old posts have a clicks number
 * but no go link — so for each Starter Story post with clicks > 0 and no
 * existing hubandspoke-minted link, we create an ARCHIVED, `legacy`-tagged go
 * link pre-loaded with that click count (clicks_count seed; archived so it
 * never serves a redirect or accrues new clicks). The sync job then reads the
 * count back into the column, keeping the historical baseline visible.
 *
 * Idempotent: skips any post that already has a hubandspoke link (by
 * content_external_id) and skips slug collisions (409).
 *
 * Defaults to --dry-run. Pass --apply to actually create links.
 *
 *   node --env-file=.env.local scripts/backfill-legacy-clicks.mjs           # dry
 *   node --env-file=.env.local scripts/backfill-legacy-clicks.mjs --apply   # commit
 *   heroku run --app hubandspoke node scripts/backfill-legacy-clicks.mjs --apply
 */
import postgres from "postgres";

const apply = process.argv.slice(2).includes("--apply");
const dryRun = !apply;

const databaseUrl = process.env.DATABASE_URL;
const apiUrl = process.env.SHORT_LINKS_API_URL;
const apiKey = process.env.SHORT_LINKS_API_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL not set");
if (!apiUrl || !apiKey)
  throw new Error("SHORT_LINKS_API_URL and SHORT_LINKS_API_KEY must be set");

const base = apiUrl.replace(/\/$/, "");
const sql = postgres(databaseUrl, { ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  return res;
}

// POST with retry on Cloudflare 429 ("Just a moment…") + 5xx. The endpoint sits
// behind Cloudflare, which rate-limits a tight loop of writes — back off and
// retry rather than hammering.
async function apiWithRetry(path, init, attempts = 5) {
  let wait = 1000;
  for (let i = 0; i < attempts; i++) {
    const res = await api(path, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (i === attempts - 1) return res;
    await sleep(wait);
    wait = Math.min(wait * 2, 15000);
  }
}

async function main() {
  console.log(`[backfill-legacy-clicks] mode=${dryRun ? "DRY RUN" : "APPLY"}`);

  // 1) Posts that already have a hubandspoke-minted link — skip these.
  const listRes = await api("/short_links?include_archived=true");
  if (!listRes.ok) throw new Error(`list short_links failed: ${listRes.status}`);
  const { short_links: links } = await listRes.json();
  const haveLink = new Set(
    links
      .filter((l) => l.content_source === "hubandspoke" && l.content_external_id)
      .map((l) => l.content_external_id),
  );
  console.log(`[backfill-legacy-clicks] ${haveLink.size} posts already have a go link`);

  // 2) Starter Story posts with historical clicks and no link yet.
  const rows = await sql`
    SELECT id, clicks, utm_campaign, title
    FROM production_items
    WHERE brand = 'starter-story' AND clicks IS NOT NULL AND clicks > 0
    ORDER BY clicks DESC
  `;
  const candidates = rows.filter((r) => !haveLink.has(r.id));
  console.log(
    `[backfill-legacy-clicks] ${rows.length} posts with clicks>0, ${candidates.length} need a legacy link`,
  );

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of candidates) {
    const slug = `legacy-${String(row.id).replace(/-/g, "").slice(0, 12)}`;
    const utm = (row.utm_campaign ?? "").trim();
    const destination = utm
      ? `https://www.starterstory.com/?utm_campaign=${encodeURIComponent(utm)}`
      : "https://www.starterstory.com/";

    if (dryRun) {
      console.log(
        `  would create ${slug} clicks=${row.clicks} utm=${utm || "(none)"} — ${String(row.title ?? "").slice(0, 50)}`,
      );
      created += 1;
      continue;
    }

    const res = await apiWithRetry("/short_links", {
      method: "POST",
      body: JSON.stringify({
        short_link: {
          slug,
          destination_url: destination,
          tag: "legacy",
          archived: true,
          content_source: "hubandspoke",
          content_external_id: row.id,
          utm_campaign: utm || null,
          clicks_count: row.clicks,
        },
      }),
    });
    if (res.status === 201) {
      created += 1;
    } else if (res.status === 409) {
      skipped += 1; // slug already exists — treat as done
    } else {
      failed += 1;
      const body = await res.text().catch(() => "");
      console.warn(`  FAILED ${slug} (${res.status}): ${body.slice(0, 120)}`);
    }
    // Gentle pacing so we don't trip Cloudflare's write rate limit.
    await sleep(200);
  }

  console.log(
    `[backfill-legacy-clicks] done — created=${created} skipped=${skipped} failed=${failed}${dryRun ? " (dry run, nothing written)" : ""}`,
  );
  await sql.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});
