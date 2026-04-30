/**
 * Read-only diagnostic: coverage of the signals we'd use to detect reposts.
 *
 * Question this answers: of all candidate `production_items` rows that *could*
 * be a mis-classified repost, how many do we have enough data on to actually
 * fingerprint and match?
 *
 *   node --env-file=.env.local scripts/check-repost-detection-coverage.mjs
 *   heroku run --app=hubandspoke node scripts/check-repost-detection-coverage.mjs
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
  prepare: false,
});

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Number(n).toLocaleString();

console.log("\n=== Source-type breakdown (live items only) ===");
const sourceBreakdown = await sql`
  SELECT source_type, COUNT(*)::int AS n
  FROM production_items
  WHERE deleted_at IS NULL
  GROUP BY 1
  ORDER BY n DESC
`;
for (const r of sourceBreakdown) {
  console.log(`  ${pad(r.source_type ?? "(null)", 14)} ${num(r.n)}`);
}

console.log("\n=== Coverage on `original` items (the cleanup candidates) ===");
const coverage = await sql`
  SELECT
    COUNT(*)::int                                                                               AS total,
    COUNT(*) FILTER (WHERE title IS NOT NULL AND title <> '')::int                              AS has_title,
    COUNT(*) FILTER (WHERE content_body IS NOT NULL AND content_body <> '')::int                AS has_content_body,
    COUNT(*) FILTER (WHERE account_id IS NOT NULL)::int                                         AS has_account_id,
    COUNT(*) FILTER (WHERE platform IS NOT NULL AND jsonb_array_length(COALESCE(platform, '[]'::jsonb)) > 0)::int AS has_legacy_platform,
    COUNT(*) FILTER (WHERE published_date IS NOT NULL)::int                                     AS has_published_date,
    COUNT(*) FILTER (WHERE status = 'Published')::int                                           AS published,
    COUNT(*) FILTER (WHERE media_s3_key IS NOT NULL OR content_media_url IS NOT NULL)::int      AS has_media,
    COUNT(*) FILTER (WHERE enrichment_completed_at IS NOT NULL)::int                            AS enriched
  FROM production_items
  WHERE deleted_at IS NULL AND source_type = 'original'
`;
const c = coverage[0];
const pct = (n) => `${((n / c.total) * 100).toFixed(1)}%`;
console.log(`  Total live originals:           ${num(c.total)}`);
console.log(`    with title:                   ${num(c.has_title)}  (${pct(c.has_title)})`);
console.log(`    with contentBody:             ${num(c.has_content_body)}  (${pct(c.has_content_body)})`);
console.log(`    with accountId:               ${num(c.has_account_id)}  (${pct(c.has_account_id)})`);
console.log(`    with legacy platform JSONB:   ${num(c.has_legacy_platform)}  (${pct(c.has_legacy_platform)})`);
console.log(`    with publishedDate:           ${num(c.has_published_date)}  (${pct(c.has_published_date)})`);
console.log(`    status='Published':           ${num(c.published)}  (${pct(c.published)})`);
console.log(`    with archived media:          ${num(c.has_media)}  (${pct(c.has_media)})`);
console.log(`    enriched:                     ${num(c.enriched)}  (${pct(c.enriched)})`);

console.log("\n=== Existing-script eligibility (mirrors backfill-repost-classification.mjs filters) ===");
// Replicates the WHERE clause in backfill-repost-classification.mjs lines 144-167.
const eligible = await sql`
  SELECT COUNT(*)::int AS n
  FROM production_items
  WHERE deleted_at IS NULL
    AND source_type = 'original'
    AND status = 'Published'
    AND published_date IS NOT NULL
    AND title IS NOT NULL
    AND title <> ''
    AND title NOT ILIKE '%(Backfilled)%'
`;
const eligibleWithPlatform = await sql`
  SELECT COUNT(*)::int AS n
  FROM production_items
  WHERE deleted_at IS NULL
    AND source_type = 'original'
    AND status = 'Published'
    AND published_date IS NOT NULL
    AND title IS NOT NULL
    AND title <> ''
    AND title NOT ILIKE '%(Backfilled)%'
    AND platform IS NOT NULL
    AND jsonb_array_length(COALESCE(platform, '[]'::jsonb)) > 0
`;
console.log(`  Eligible by existing filters (title + Published):              ${num(eligible[0].n)}`);
console.log(`  Of those, with non-empty legacy platform JSONB (Pass 1 needs): ${num(eligibleWithPlatform[0].n)}`);
console.log(`  Silently skipped by Pass 1 (no legacy platform JSONB):         ${num(eligible[0].n - eligibleWithPlatform[0].n)}`);

console.log("\n=== Items written after the legacy-platform stop-date (2026-04-25) ===");
const cutoff = await sql`
  SELECT
    COUNT(*) FILTER (WHERE source_type = 'original' AND deleted_at IS NULL)::int                                            AS originals_total,
    COUNT(*) FILTER (WHERE source_type = 'original' AND deleted_at IS NULL AND created_at >= '2026-04-25'::timestamptz)::int AS originals_post_cutoff,
    COUNT(*) FILTER (WHERE source_type = 'original' AND deleted_at IS NULL AND created_at >= '2026-04-25'::timestamptz
                     AND (platform IS NULL OR jsonb_array_length(COALESCE(platform, '[]'::jsonb)) = 0))::int                AS originals_post_cutoff_no_platform
  FROM production_items
`;
const k = cutoff[0];
console.log(`  Originals created after 2026-04-25:                ${num(k.originals_post_cutoff)} of ${num(k.originals_total)} total`);
console.log(`  ↳ of those, missing legacy platform JSONB:         ${num(k.originals_post_cutoff_no_platform)}  (these are the ones the existing script silently skips)`);

console.log("\n=== Pomodoro cluster spot-check (the screenshot the user sent) ===");
const pomodoro = await sql`
  SELECT pi.id, pi.title, pi.source_type, pi.published_date,
         a.handle AS account_handle, a.platform AS account_platform,
         (pi.platform IS NOT NULL AND jsonb_array_length(COALESCE(pi.platform, '[]'::jsonb)) > 0) AS has_legacy_platform,
         (pi.content_body IS NOT NULL AND pi.content_body <> '')                                  AS has_content_body,
         length(COALESCE(pi.content_body, ''))                                                    AS body_len
  FROM production_items pi
  LEFT JOIN accounts a ON a.id = pi.account_id
  WHERE pi.deleted_at IS NULL
    AND pi.title ILIKE '%still convinced%'
  ORDER BY pi.published_date NULLS LAST
  LIMIT 30
`;
console.log(`  Found ${pomodoro.length} matching items`);
for (const r of pomodoro) {
  console.log(
    `    ${pad(r.source_type ?? "?", 11)}  ${pad(r.account_handle ?? "?", 16)}  ${pad(r.account_platform ?? "?", 10)}  ` +
      `${pad(r.published_date ? r.published_date.toISOString().slice(0, 10) : "?", 10)}  ` +
      `legacyPlatform=${r.has_legacy_platform ? "Y" : "N"}  body=${r.has_content_body ? `${r.body_len}ch` : "—"}  ` +
      `"${(r.title ?? "").slice(0, 50)}"`
  );
}

console.log("\n=== Best-available fingerprint signal (per source_type=original) ===");
const fingerprintCoverage = await sql`
  SELECT
    COUNT(*)::int                                                                                             AS total,
    COUNT(*) FILTER (WHERE title IS NOT NULL AND title <> '')::int                                            AS title_only,
    COUNT(*) FILTER (WHERE content_body IS NOT NULL AND content_body <> '')::int                              AS body_only,
    COUNT(*) FILTER (WHERE (title IS NOT NULL AND title <> '') OR (content_body IS NOT NULL AND content_body <> ''))::int AS title_or_body,
    COUNT(*) FILTER (WHERE account_id IS NOT NULL AND ((title IS NOT NULL AND title <> '') OR (content_body IS NOT NULL AND content_body <> '')))::int AS title_or_body_and_account
  FROM production_items
  WHERE deleted_at IS NULL AND source_type = 'original'
`;
const fc = fingerprintCoverage[0];
const fpct = (n) => `${((n / fc.total) * 100).toFixed(1)}%`;
console.log(`  Has title:                              ${num(fc.title_only)} (${fpct(fc.title_only)})`);
console.log(`  Has contentBody:                        ${num(fc.body_only)} (${fpct(fc.body_only)})`);
console.log(`  Has either title or contentBody:        ${num(fc.title_or_body)} (${fpct(fc.title_or_body)})`);
console.log(`  Has (title or body) AND accountId:      ${num(fc.title_or_body_and_account)} (${fpct(fc.title_or_body_and_account)})`);
console.log(`  ↳ accountId is needed because a.platform is the live source-of-truth for "same platform" once legacy column is dropped.`);

await sql.end();
