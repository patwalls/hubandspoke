/**
 * Prune pending cross-post Idea rows whose source item no longer clears the
 * current active rule's view threshold (or where no active rule exists for
 * that source → target pair at all).
 *
 * Only touches production_items rows where:
 *   source_type = 'cross_post' AND status = 'Idea'
 *
 * A row is pruned if one of:
 *   - no active cross_post_rule matches (source.platform ∈ rule.source_platform,
 *     rule.target_platform = crosspost.platform[0], brand matches)
 *   - the matching rule's view_threshold is above source.views
 *
 * Why delete rather than mark Killed: these are bot-generated queue noise that
 * never existed outside the queue. The cross-post scanner is idempotent and
 * will re-create any row that later crosses a threshold, so deletion is safe.
 *
 * Usage:
 *   node --env-file=.env.local scripts/prune-crosspost-queue-below-threshold.mjs          # dry-run
 *   node --env-file=.env.local scripts/prune-crosspost-queue-below-threshold.mjs --apply  # delete
 */
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

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

// Platform-label synonyms. When the cross-post scanner was originally run the
// Twitter column was labeled "X (Starter Story)"; it was later renamed to
// "Twitter" and the rules were updated, but legacy queue rows still carry the
// old label. Treat them as equivalent when matching (source_platform,
// target_platform) against a rule. Keyed canonical → alternates.
const PLATFORM_SYNONYMS = {
  Twitter: ["X (Starter Story)"],
};
const SYNONYM_TO_CANONICAL = new Map();
for (const [canonical, alts] of Object.entries(PLATFORM_SYNONYMS)) {
  SYNONYM_TO_CANONICAL.set(canonical, canonical);
  for (const alt of alts) SYNONYM_TO_CANONICAL.set(alt, canonical);
}
function canonicalize(platform) {
  return SYNONYM_TO_CANONICAL.get(platform) ?? platform;
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (use --apply to delete)" : "APPLY"}\n`);

  const rules = await sql`
    SELECT brand, source_platform, target_platform, view_threshold
    FROM cross_post_rules
    WHERE active = true
  `;

  if (rules.length === 0) {
    console.log("No active rules. Every pending cross-post would be pruned.");
  } else {
    console.log(`Active rules (${rules.length}):`);
    for (const r of rules) {
      console.log(
        `  ${r.brand} | ${r.source_platform} ≥ ${Number(r.view_threshold).toLocaleString()} → ${r.target_platform}`
      );
    }
    console.log();
  }

  // ruleMap[`${brand}::${source}::${target}`] = threshold — canonicalize both
  // the rule's source and target so we match against queue rows that use
  // legacy platform labels (e.g. "X (Starter Story)" for "Twitter").
  const ruleMap = new Map();
  for (const r of rules) {
    const src = canonicalize(r.source_platform);
    const tgt = canonicalize(r.target_platform);
    ruleMap.set(`${r.brand}::${src}::${tgt}`, Number(r.view_threshold));
  }

  const candidates = await sql`
    SELECT
      cp.id          AS cp_id,
      cp.title       AS cp_title,
      cp.platform    AS cp_platform,
      cp.brand       AS cp_brand,
      src.id         AS src_id,
      src.platform   AS src_platform,
      src.views      AS src_views
    FROM production_items cp
    LEFT JOIN production_items src ON src.id = cp.reposted_from_item_id
    WHERE cp.source_type = 'cross_post'
      AND cp.status = 'Idea'
  `;

  const toPrune = [];
  const kept = [];

  for (const c of candidates) {
    // Some legacy rows have `platform` double-serialized (a JSON string
    // containing "[\"TikTok\"]" rather than an array). The `postgres` driver
    // returns those as strings, not arrays. Treat them as unusable.
    const malformedTarget = typeof c.cp_platform === "string";
    const targetPlatforms = Array.isArray(c.cp_platform) ? c.cp_platform : [];
    const sourcePlatforms = Array.isArray(c.src_platform) ? c.src_platform : [];
    const target = targetPlatforms[0] ? canonicalize(targetPlatforms[0]) : undefined;
    const canonicalSources = sourcePlatforms.map(canonicalize);

    if (malformedTarget) {
      toPrune.push({
        ...c,
        reason: "malformed platform (double-serialized JSON string)",
      });
      continue;
    }

    // No target platform on the cross-post row at all — unusable, prune.
    if (!target) {
      toPrune.push({ ...c, reason: "cross-post has no target platform" });
      continue;
    }

    // No source item (orphaned FK) — prune.
    if (!c.src_id) {
      toPrune.push({ ...c, reason: "source item missing (orphan)" });
      continue;
    }

    // Find the best (lowest) active threshold where the source shares the
    // rule's source platform. If none matches, prune. Both the source and
    // target are canonicalized so legacy labels match current rule names.
    let matchedRule = null;
    let matchedThreshold = null;
    for (const srcPlat of canonicalSources) {
      const key = `${c.cp_brand}::${srcPlat}::${target}`;
      const threshold = ruleMap.get(key);
      if (threshold !== undefined) {
        if (matchedThreshold === null || threshold < matchedThreshold) {
          matchedRule = `${srcPlat} → ${target}`;
          matchedThreshold = threshold;
        }
      }
    }

    if (matchedThreshold === null) {
      toPrune.push({
        ...c,
        reason: `no active rule for [${sourcePlatforms.join(",")}] → ${target}`,
      });
      continue;
    }

    const srcViews = c.src_views ?? 0;
    if (srcViews < matchedThreshold) {
      toPrune.push({
        ...c,
        reason: `${srcViews.toLocaleString()} < ${matchedThreshold.toLocaleString()} (${matchedRule})`,
      });
    } else {
      kept.push({ ...c, matchedRule, matchedThreshold });
    }
  }

  console.log(
    `Evaluated ${candidates.length} pending cross-posts: ${toPrune.length} to prune, ${kept.length} to keep.\n`
  );

  // Group prune reasons by target platform for a compact summary.
  const byTarget = new Map();
  for (const p of toPrune) {
    const t = Array.isArray(p.cp_platform)
      ? p.cp_platform[0] ?? "(no target)"
      : "(malformed)";
    byTarget.set(t, (byTarget.get(t) ?? 0) + 1);
  }
  console.log("Prune breakdown by target platform:");
  for (const [t, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }
  console.log();

  // Show a small sample of the items being pruned so the operator can sanity-check.
  console.log("Sample of items to prune (up to 20):");
  for (const p of toPrune.slice(0, 20)) {
    const target = Array.isArray(p.cp_platform)
      ? p.cp_platform[0] ?? "?"
      : "malformed";
    console.log(
      `  [${target}] ${p.cp_title?.slice(0, 60) ?? "(untitled)"} — ${p.reason}`
    );
  }
  if (toPrune.length > 20) {
    console.log(`  …and ${toPrune.length - 20} more`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(
      `DRY RUN — nothing deleted. Re-run with --apply to delete ${toPrune.length} row${
        toPrune.length === 1 ? "" : "s"
      }.`
    );
    await sql.end();
    return;
  }

  if (toPrune.length === 0) {
    console.log("Nothing to delete.");
    await sql.end();
    return;
  }

  const ids = toPrune.map((p) => p.cp_id);
  const deleted = await sql`
    DELETE FROM production_items
    WHERE id = ANY(${ids}::uuid[])
      AND source_type = 'cross_post'
      AND status = 'Idea'
    RETURNING id
  `;
  console.log(`Deleted ${deleted.length} row${deleted.length === 1 ? "" : "s"}.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
