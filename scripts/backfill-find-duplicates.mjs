/**
 * Read-only diagnostic: find production_items rows that share a
 * platform_content_id or a normalized published_link across accounts.
 *
 * Why: cross-account duplicates double-count views in every aggregation
 * (formats route, dashboard totals, descendant rollups). The new global
 * unique indexes (`uniq_production_items_platform_content_id_global`,
 * `uniq_production_items_published_link_global`) reject inserts with the
 * same id/url across the whole table — but they will *fail to apply* if
 * duplicates already exist. Run this against prod, resolve every group
 * manually, then re-run until output is empty before deploying the
 * schema PR.
 *
 * Resolution heuristic per group (see suggested action below):
 *   - one `original` + one `repost`/`cross_post` with NULL repostedFromItemId
 *     on a *different* account → suggest delete the non-original row
 *     (same-URL "repost" is a data-entry mistake — the second account never
 *     actually posted that URL).
 *   - two `original` rows on different accounts → ambiguous, flag for human
 *     review.
 *   - one row already has repostedFromItemId pointing inside the group →
 *     suggest leaving it (already linked).
 *
 * No --apply flag. Resolve via DELETE /api/production-items/[id] or PUT
 * (sourceType + repostedFromItemId) — judgment calls belong to a human.
 *
 *   node --env-file=.env.local scripts/backfill-find-duplicates.mjs
 *   heroku run --app=hubandspoke node scripts/backfill-find-duplicates.mjs
 */
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

function fmtViews(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function suggestion(rows) {
  const original = rows.find((r) => r.source_type === "original");
  const linked = rows.find((r) => r.reposted_from_item_id != null);
  if (linked) {
    return `Already linked — review whether the link target is correct, otherwise leave as-is.`;
  }
  const nonOriginal = rows.filter((r) => r.source_type !== "original");
  if (original && nonOriginal.length >= 1) {
    const drop = nonOriginal[0];
    return `DELETE id=${drop.id} (account=@${drop.account_handle ?? "?"}, source=${drop.source_type}). Or PUT { sourceType: "${drop.source_type}", repostedFromItemId: "${original.id}", publishedLink: null } to keep an editorial record without separate metrics.`;
  }
  const originals = rows.filter((r) => r.source_type === "original");
  if (originals.length >= 2) {
    return `AMBIGUOUS — ${originals.length} rows claim source_type='original' on different accounts. Decide which one is the canonical post and convert the other(s) to repost or delete.`;
  }
  return `Multiple non-original rows — pick the canonical one and either delete or link the rest.`;
}

async function reportGroup(label, rows) {
  console.log(`\n=== ${label} (${rows.length} row${rows.length === 1 ? "" : "s"}) ===`);
  // Cap large groups (e.g. placeholder URLs like the homepage with 1k+ rows)
  // — print first few rows + a count so output stays readable.
  const cap = 6;
  const shown = rows.slice(0, cap);
  for (const r of shown) {
    console.log(
      `  id=${r.id}  account=@${r.account_handle ?? "?"}  source=${r.source_type}  views=${fmtViews(Number(r.views))}  link=${r.published_link ?? "(null)"}`
    );
  }
  if (rows.length > cap) {
    console.log(`  … ${rows.length - cap} more row(s) elided`);
  }
  console.log(`  Suggested: ${suggestion(rows)}`);
}

let total = 0;

try {
  // Pass 1: collisions on platform_content_id (most reliable — natural keys)
  const byContentId = await sql`
    WITH groups AS (
      SELECT platform_content_id, count(*) AS n
      FROM production_items
      WHERE platform_content_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY platform_content_id
      HAVING count(*) > 1
    )
    SELECT g.platform_content_id, p.id, p.source_type, p.views,
           p.published_link, p.reposted_from_item_id,
           a.handle AS account_handle
    FROM groups g
    JOIN production_items p
      ON p.platform_content_id = g.platform_content_id
     AND p.deleted_at IS NULL
    LEFT JOIN accounts a ON a.id = p.account_id
    ORDER BY g.platform_content_id, p.created_at
  `;
  const groupedById = new Map();
  for (const r of byContentId) {
    if (!groupedById.has(r.platform_content_id))
      groupedById.set(r.platform_content_id, []);
    groupedById.get(r.platform_content_id).push(r);
  }
  for (const [key, rows] of groupedById) {
    total++;
    await reportGroup(`Duplicate group: platform_content_id=${key}`, rows);
  }

  // Pass 2: collisions on normalized publishedLink (catches LinkedIn,
  // newsletters, manual entries — rows whose platform_content_id is null).
  // Skip rows already surfaced in pass 1 to keep output focused.
  const surfacedIds = new Set(byContentId.map((r) => r.id));
  const byUrl = await sql`
    WITH groups AS (
      SELECT lower(trim(trailing '/' from published_link)) AS link_key, count(*) AS n
      FROM production_items
      WHERE published_link IS NOT NULL AND deleted_at IS NULL
      GROUP BY lower(trim(trailing '/' from published_link))
      HAVING count(*) > 1
    )
    SELECT g.link_key, p.id, p.source_type, p.views,
           p.published_link, p.reposted_from_item_id,
           a.handle AS account_handle
    FROM groups g
    JOIN production_items p
      ON lower(trim(trailing '/' from p.published_link)) = g.link_key
     AND p.deleted_at IS NULL
    LEFT JOIN accounts a ON a.id = p.account_id
    ORDER BY g.link_key, p.created_at
  `;
  const groupedByUrl = new Map();
  for (const r of byUrl) {
    if (!groupedByUrl.has(r.link_key)) groupedByUrl.set(r.link_key, []);
    groupedByUrl.get(r.link_key).push(r);
  }
  for (const [key, rows] of groupedByUrl) {
    if (rows.every((r) => surfacedIds.has(r.id))) continue;
    total++;
    await reportGroup(`Duplicate group: published_link=${key}`, rows);
  }

  console.log("");
  if (total === 0) {
    console.log("No duplicates found. Safe to apply the global unique indexes.");
  } else {
    console.log(
      `Found ${total} duplicate group(s). Resolve each, re-run until empty, then deploy the schema PR.`
    );
    process.exit(2);
  }
} finally {
  await sql.end({ timeout: 5 });
}
