/**
 * One-shot: revert a single cross-post format migration back to a child format
 * in the formats tree (i.e., reclassify from cross_post back to repurpose).
 *
 * Use when a migrated cross-post format actually needs per-platform edits and
 * belongs as a repurpose derivative, not a same-content cross-post.
 *
 * Safe to re-run: identifies target items by (sourceType='cross_post' +
 * repostedFromItemId's pillar has the parent format name + target platform).
 *
 * Usage:
 *   heroku run --app=hubandspoke "node scripts/revert-crosspost-format.mjs \
 *     --name='Business Breakdown → Full Video On X' \
 *     --parent='Business Breakdown' \
 *     --platform=Twitter \
 *     --brand=starter-story"
 *
 *   # add --apply to write
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;

function arg(flag, def = null) {
  const hit = args.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
}

const FORMAT_NAME = arg("name");
const PARENT_NAME = arg("parent");
const TARGET_PLATFORM = arg("platform");
const BRAND = arg("brand", "starter-story");

if (!FORMAT_NAME || !PARENT_NAME || !TARGET_PLATFORM) {
  console.error(
    "Required: --name=<child format name> --parent=<pillar format name> --platform=<target platform>"
  );
  process.exit(1);
}

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

async function main() {
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log(
    `Reverting "${FORMAT_NAME}" (child of "${PARENT_NAME}") on ${BRAND}, target=${TARGET_PLATFORM}\n`
  );

  // 1. Find the parent (pillar) format
  const [parent] = await sql`
    SELECT id, name FROM formats
    WHERE name = ${PARENT_NAME} AND brand = ${BRAND}
    LIMIT 1
  `;
  if (!parent) {
    console.error(`Parent format "${PARENT_NAME}" not found on ${BRAND}.`);
    await sql.end();
    process.exit(1);
  }
  console.log(`Parent format: ${parent.id}`);

  // 2. Check the child format doesn't already exist
  const [existing] = await sql`
    SELECT id FROM formats
    WHERE name = ${FORMAT_NAME} AND brand = ${BRAND}
    LIMIT 1
  `;
  let childFormatId = existing?.id;
  if (childFormatId) {
    console.log(
      `Child format already exists (${childFormatId}) — will reuse, not recreate.`
    );
  } else {
    if (!dryRun) {
      const [inserted] = await sql`
        INSERT INTO formats (
          name, brand, parent_format_id,
          channels, view_threshold
        ) VALUES (
          ${FORMAT_NAME}, ${BRAND}, ${parent.id},
          ${JSON.stringify([TARGET_PLATFORM])}::jsonb, NULL
        )
        RETURNING id
      `;
      childFormatId = inserted.id;
      console.log(`Recreated child format: ${childFormatId}`);
    } else {
      childFormatId = "(would create)";
      console.log(`Would recreate child format.`);
    }
  }

  // 3. Find items to revert: sourceType='cross_post' + platform contains
  //    target + source item's format = parent's name.
  const candidates = await sql`
    SELECT p.id, p.title, p.reposted_from_item_id,
           src.id AS src_id, src.notion_id AS src_notion_id, src.format AS src_format
    FROM production_items p
    LEFT JOIN production_items src ON src.id = p.reposted_from_item_id
    WHERE p.source_type = 'cross_post'
      AND p.brand = ${BRAND}
      AND p.platform ? ${TARGET_PLATFORM}
      AND src.format = ${PARENT_NAME}
  `;

  console.log(`\n${candidates.length} items to revert:\n`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  - ${c.id}  "${(c.title ?? "").slice(0, 60)}"`);
  }
  if (candidates.length > 5) console.log(`  ... and ${candidates.length - 5} more`);

  if (candidates.length === 0) {
    console.log("Nothing to revert.");
    await sql.end();
    return;
  }

  // 4. Revert each: restore pillar linkage + old format text + original source type.
  //    The (pillar, format) unique index means if two cross_posts share a pillar
  //    we can only restore one — skip the later one and leave it as cross_post
  //    for the operator to triage.
  let reverted = 0;
  let skippedDupe = 0;
  for (const c of candidates) {
    if (!c.src_id) {
      console.log(`  [skip] ${c.id} — reposted_from_item_id dangles, can't restore pillar`);
      continue;
    }
    if (!dryRun) {
      try {
        await sql`
          UPDATE production_items
          SET source_type = 'original',
              format = ${FORMAT_NAME},
              pillar_content_item_id = ${c.src_id},
              pillar_content_notion_id = ${c.src_notion_id},
              reposted_from_item_id = NULL,
              updated_at = now()
          WHERE id = ${c.id}
        `;
        reverted++;
      } catch (err) {
        if (err.code === "23505") {
          console.log(
            `  [dupe] ${c.id} — pillar ${c.src_id} already has another (pillar, format) row; left as cross_post`
          );
          skippedDupe++;
        } else {
          throw err;
        }
      }
    } else {
      reverted++;
    }
  }

  console.log(
    `\n${dryRun ? "Would revert" : "Reverted"} ${reverted} items to sourceType='original' with format='${FORMAT_NAME}'.` +
      (skippedDupe > 0 ? ` Skipped ${skippedDupe} duplicate pillar(s).` : "")
  );
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
