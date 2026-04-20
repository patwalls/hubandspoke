/**
 * One-shot migration: convert "cross-post-shaped" child formats to the new
 * cross_post source type.
 *
 * Before: cross-posting lived as child formats in the formats tree (e.g.
 *   "Reel → X", "Case Study Tease → LinkedIn" badged "Repurposed"). Items
 *   with those formats were `sourceType='original'` but semantically a
 *   different-platform rerun of the pillar.
 *
 * After: those items become `sourceType='cross_post'`, linked via
 *   `repostedFromItemId` to the pillar original, with `format=NULL` and
 *   `pillarContentItemId=NULL`. The format row is deleted. The formats tree
 *   is reserved for real repurpose (content transformation) work.
 *
 * Usage:
 *   # list candidate formats whose names look like platform cross-posts
 *   node --env-file=.env.local scripts/migrate-crosspost-formats.mjs --list-candidates
 *
 *   # dry-run migrating specific format IDs
 *   node --env-file=.env.local scripts/migrate-crosspost-formats.mjs \
 *     --format-ids=<uuid>,<uuid>,<uuid>
 *
 *   # apply
 *   node --env-file=.env.local scripts/migrate-crosspost-formats.mjs \
 *     --format-ids=<uuid>,<uuid> --apply
 *
 * On Heroku:
 *   heroku run --app=hubandspoke node scripts/migrate-crosspost-formats.mjs --list-candidates
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;
const listCandidates = args.includes("--list-candidates");
const formatIdsArg = args
  .find((a) => a.startsWith("--format-ids="))
  ?.split("=")[1];
const formatIds = formatIdsArg
  ? formatIdsArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

if (!listCandidates && formatIds.length === 0) {
  console.error(
    "Pass --list-candidates OR --format-ids=<uuid>,<uuid>,... (use --apply to write)."
  );
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: connectionString.includes("localhost") ? false : "require",
  max: 1,
});

// Keywords used to detect formats that read like platform cross-posts. Tuned
// from looking at the current formats tree; adjust if the taxonomy evolves.
const PLATFORM_TOKENS = [
  "twitter",
  " x ",
  "→ x",
  "linkedin",
  "tiktok",
  "threads",
  "instagram",
  "reel",
  "youtube short",
  "yt short",
  "yt community",
  "youtube community",
];

function looksLikeCrossPost(name) {
  if (!name) return false;
  const lower = " " + name.toLowerCase() + " ";
  if (!/[→>]/.test(name)) return false;
  return PLATFORM_TOKENS.some((t) => lower.includes(t));
}

async function main() {
  if (listCandidates) {
    const rows = await sql`
      SELECT id, name, brand, parent_format_id, view_threshold, channels
      FROM formats
      WHERE parent_format_id IS NOT NULL
      ORDER BY brand, name
    `;
    const candidates = rows.filter((r) => looksLikeCrossPost(r.name));
    console.log(
      `\n${candidates.length} candidate cross-post-shaped child formats:\n`
    );
    for (const r of candidates) {
      const itemCount = await sql`
        SELECT COUNT(*)::int AS n
        FROM production_items
        WHERE format = ${r.name}
      `;
      console.log(
        `  ${r.id}  ${r.brand.padEnd(16)}  ${r.name}  [${itemCount[0].n} item${
          itemCount[0].n === 1 ? "" : "s"
        }]`
      );
    }
    console.log(
      "\nPass the IDs you want to migrate via --format-ids=<id>,<id>,... (dry-run first)."
    );
    await sql.end();
    return;
  }

  console.log(`Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"}`);
  console.log(`Formats to migrate: ${formatIds.length}\n`);

  const totals = {
    formatsDeleted: 0,
    itemsConverted: 0,
    itemsOrphaned: 0,
    triggersDeleted: 0,
  };

  for (const formatId of formatIds) {
    const [format] = await sql`
      SELECT id, name, brand, parent_format_id
      FROM formats
      WHERE id = ${formatId}
      LIMIT 1
    `;

    if (!format) {
      console.log(`  [skip] ${formatId} — not found`);
      continue;
    }
    if (!format.parent_format_id) {
      console.log(
        `  [skip] ${formatId} — ${format.name} has no parent (looks like a pillar, refuse)`
      );
      continue;
    }

    // Find items using this format as text name + brand. Join the pillar to
    // inherit its format onto the cross-post row — pillar linkage is ground
    // truth even when the child-format label drifted from what the item
    // actually is (we found items tagged "Case Study Tease → YT Community"
    // whose pillar was actually "Laptop POV"). Platform stays as-is: it
    // already reflects where the cross-post lives.
    const items = await sql`
      SELECT p.id, p.title, p.pillar_content_item_id,
             pp.format AS pillar_format
      FROM production_items p
      LEFT JOIN production_items pp ON pp.id = p.pillar_content_item_id
      WHERE p.format = ${format.name} AND p.brand = ${format.brand}
    `;

    let converted = 0;
    let orphaned = 0;
    for (const item of items) {
      if (!item.pillar_content_item_id) {
        orphaned++;
        console.log(
          `    [orphan] ${item.id}  "${(item.title ?? "").slice(0, 60)}" — no pillar; skipping (leave alone)`
        );
        continue;
      }

      if (!dryRun) {
        await sql`
          UPDATE production_items
          SET source_type = 'cross_post',
              reposted_from_item_id = ${item.pillar_content_item_id},
              format = ${item.pillar_format},
              pillar_content_item_id = NULL,
              pillar_content_notion_id = NULL,
              updated_at = now()
          WHERE id = ${item.id}
        `;
      }
      converted++;
    }

    // Clean up repurpose_triggers rows pointing at this format
    const triggerRows = await sql`
      SELECT id FROM repurpose_triggers
      WHERE source_format_id = ${formatId} OR target_format_id = ${formatId}
    `;
    if (!dryRun && triggerRows.length > 0) {
      await sql`
        DELETE FROM repurpose_triggers
        WHERE source_format_id = ${formatId} OR target_format_id = ${formatId}
      `;
    }

    if (!dryRun) {
      await sql`DELETE FROM formats WHERE id = ${formatId}`;
    }

    totals.itemsConverted += converted;
    totals.itemsOrphaned += orphaned;
    totals.triggersDeleted += triggerRows.length;
    totals.formatsDeleted += 1;

    console.log(
      `  ${dryRun ? "[dry]" : "[done]"} ${format.name} (${format.brand}) — ` +
        `converted ${converted}, orphaned ${orphaned}, triggers ${triggerRows.length}`
    );

    // Preview a few rewrites so dry-run callers can spot-check the format
    // inheritance before they pass --apply.
    if (dryRun) {
      const sample = items.filter((i) => i.pillar_content_item_id).slice(0, 3);
      for (const i of sample) {
        const newFormat = i.pillar_format ?? "(null)";
        console.log(
          `      e.g., "${(i.title ?? "").slice(0, 50)}" → format="${newFormat}"`
        );
      }
    }
  }

  console.log(
    `\n${dryRun ? "Would" : "Did"} delete ${totals.formatsDeleted} formats, ` +
      `convert ${totals.itemsConverted} items to cross_post, ` +
      `skip ${totals.itemsOrphaned} orphans, ` +
      `delete ${totals.triggersDeleted} repurpose_triggers rows.`
  );

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
