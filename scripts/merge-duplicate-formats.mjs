/**
 * Merge `<name> (N)` format rows back into their canonical `<name>` row.
 *
 * Background: until 2026-04, production_items had a partial unique index
 * `uniq_production_items_pillar_format` on (pillar_content_item_id,
 * lower(format)) that blocked creating a second production item for the
 * same (pillar, format). To work around it, operators created sibling
 * format rows with names like "Reel: Repackage Section w/ Hook (2)",
 * "(3)", "(4)" so each production_items.format text differed and slipped
 * past the index. The index was dropped in migration 0056 and dedup now
 * lives at the cron-generation step. This script consolidates the
 * workaround formats back into their canonical rows.
 *
 * For each duplicate group:
 *   - reparent any child formats from <duplicate> to <canonical>
 *   - merge format_channels rows into <canonical> (ON CONFLICT DO NOTHING)
 *   - repoint repurpose_triggers source_format_id and target_format_id
 *   - rename production_items.format text from <duplicate name> to <canonical name>
 *   - delete the duplicate format row
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 * Re-runnable: a successful --apply leaves no `(N)`-suffix rows, so a
 * second run is a no-op.
 *
 *   node --env-file=.env.local scripts/merge-duplicate-formats.mjs           # dry
 *   node --env-file=.env.local scripts/merge-duplicate-formats.mjs --apply   # commit
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

// "Foo (2)" → { base: "Foo", n: 2 }. Returns null if name doesn't match.
function parseSuffix(name) {
  const m = /^(.*?)\s+\((\d+)\)$/.exec(name);
  if (!m) return null;
  return { base: m[1], n: Number(m[2]) };
}

console.log(`Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"}`);

try {
  // 1. Pull every format with a "(N)" suffix.
  const dupes = await sql`
    SELECT id, brand, name
    FROM formats
    WHERE name ~ ' \\(\\d+\\)$'
  `;
  console.log(`Found ${dupes.length} formats with a "(N)" suffix.`);

  if (dupes.length === 0) {
    console.log("Nothing to do.");
    await sql.end({ timeout: 5 });
    process.exit(0);
  }

  // 2. Resolve canonical per duplicate. Group by canonical id.
  // groups: Map<canonicalId, { canonical: {id,brand,name}, dupes: Array<{id,brand,name}> }>
  const groups = new Map();
  const orphans = []; // dupes whose base name has no canonical row

  for (const d of dupes) {
    const parsed = parseSuffix(d.name);
    if (!parsed) continue; // shouldn't happen given the regex, but be safe
    const [canonical] = await sql`
      SELECT id, brand, name
      FROM formats
      WHERE brand = ${d.brand} AND lower(name) = lower(${parsed.base})
      LIMIT 1
    `;
    if (!canonical) {
      orphans.push({ ...d, base: parsed.base });
      continue;
    }
    if (canonical.id === d.id) continue; // belt-and-suspenders, can't happen
    let g = groups.get(canonical.id);
    if (!g) {
      g = { canonical, dupes: [] };
      groups.set(canonical.id, g);
    }
    g.dupes.push(d);
  }

  console.log(`Resolved ${groups.size} merge group(s).`);
  if (orphans.length) {
    console.log(`\nOrphaned duplicates (no canonical "<base>" row, skipped):`);
    for (const o of orphans) {
      console.log(`  [${o.brand}] "${o.name}" → looking for "${o.base}"`);
    }
  }

  // 3. Per group, in a single transaction: reparent, merge channels,
  // repoint triggers, rename production_items, delete duplicates.
  let totalReparented = 0;
  let totalChannels = 0;
  let totalTriggersSrc = 0;
  let totalTriggersTgt = 0;
  let totalItemsRenamed = 0;
  let totalDeleted = 0;

  for (const { canonical, dupes: groupDupes } of groups.values()) {
    const dupIds = groupDupes.map((d) => d.id);
    const dupNames = groupDupes.map((d) => d.name);

    console.log(
      `\n[${canonical.brand}] "${canonical.name}" ← merging ${groupDupes.length} duplicate(s):`
    );
    for (const d of groupDupes) console.log(`  - "${d.name}" (${d.id})`);

    // Pre-flight counts (read-only — runs in dry mode too so the operator
    // can see the impact before applying).
    const [{ count: childCount }] = await sql`
      SELECT count(*)::int AS count FROM formats WHERE parent_format_id IN ${sql(dupIds)}
    `;
    const [{ count: channelCount }] = await sql`
      SELECT count(*)::int AS count FROM format_channels WHERE format_id IN ${sql(dupIds)}
    `;
    const [{ count: triggerSrcCount }] = await sql`
      SELECT count(*)::int AS count FROM repurpose_triggers WHERE source_format_id IN ${sql(dupIds)}
    `;
    const [{ count: triggerTgtCount }] = await sql`
      SELECT count(*)::int AS count FROM repurpose_triggers WHERE target_format_id IN ${sql(dupIds)}
    `;
    const [{ count: itemCount }] = await sql`
      SELECT count(*)::int AS count FROM production_items WHERE format IN ${sql(dupNames)}
    `;
    console.log(
      `  preview: ${childCount} child format(s), ${channelCount} format_channel(s), ` +
        `${triggerSrcCount} trigger(s) by source, ${triggerTgtCount} by target, ` +
        `${itemCount} production_item(s) to rename`
    );

    if (dryRun) {
      totalReparented += childCount;
      totalChannels += channelCount;
      totalTriggersSrc += triggerSrcCount;
      totalTriggersTgt += triggerTgtCount;
      totalItemsRenamed += itemCount;
      totalDeleted += groupDupes.length;
      continue;
    }

    await sql.begin(async (tx) => {
      // Reparent child formats.
      const reparented = await tx`
        UPDATE formats SET parent_format_id = ${canonical.id}, updated_at = now()
        WHERE parent_format_id IN ${tx(dupIds)}
      `;
      totalReparented += reparented.count;

      // Merge format_channels into canonical, then drop the duplicates'.
      // The duplicate rows would cascade-delete with the format anyway, but
      // explicit is clearer and frees up the (account, post_type) slot
      // before the canonical insert collides. The conflict target matches
      // schema.ts uniq_format_channels_format_account_post_type — note
      // COALESCE on post_type because Postgres treats NULLs as distinct in
      // unique indexes by default, and the index column is wrapped to fix
      // that.
      const channelsMoved = await tx`
        INSERT INTO format_channels (format_id, account_id, post_type)
        SELECT ${canonical.id}, account_id, post_type
        FROM format_channels
        WHERE format_id IN ${tx(dupIds)}
        ON CONFLICT (format_id, account_id, (COALESCE(post_type, ''))) DO NOTHING
      `;
      totalChannels += channelsMoved.count;
      await tx`DELETE FROM format_channels WHERE format_id IN ${tx(dupIds)}`;

      // Repoint repurpose_triggers — these FKs default to RESTRICT, so the
      // delete at the end would fail without this step.
      const trigSrc = await tx`
        UPDATE repurpose_triggers SET source_format_id = ${canonical.id}
        WHERE source_format_id IN ${tx(dupIds)}
      `;
      totalTriggersSrc += trigSrc.count;
      const trigTgt = await tx`
        UPDATE repurpose_triggers SET target_format_id = ${canonical.id}
        WHERE target_format_id IN ${tx(dupIds)}
      `;
      totalTriggersTgt += trigTgt.count;

      // Rename production_items.format text. Same shape as the rename-
      // cascade in src/app/api/formats/route.ts. Only safe now that
      // uniq_production_items_pillar_format has been dropped.
      const itemsRenamed = await tx`
        UPDATE production_items SET format = ${canonical.name}, updated_at = now()
        WHERE format IN ${tx(dupNames)}
      `;
      totalItemsRenamed += itemsRenamed.count;

      // Finally delete the duplicate format rows.
      const deleted = await tx`DELETE FROM formats WHERE id IN ${tx(dupIds)}`;
      totalDeleted += deleted.count;
    });

    console.log("  ✓ merged");
  }

  console.log(
    `\n[${dryRun ? "dry" : "applied"}] groups=${groups.size} ` +
      `reparented=${totalReparented} channels=${totalChannels} ` +
      `triggers_src=${totalTriggersSrc} triggers_tgt=${totalTriggersTgt} ` +
      `items_renamed=${totalItemsRenamed} formats_deleted=${totalDeleted}`
  );

  if (dryRun) {
    console.log("\nDry run — no writes. Re-run with --apply to execute.");
  }

  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error("Merge failed:", err);
  try {
    await sql.end({ timeout: 5 });
  } catch {}
  process.exit(1);
}
