/**
 * One-shot fix for production_items whose Descript-rendered MP4 landed at
 * a non-zero `production_item_media.index`. Symptom: simulator slides[0]
 * (and the legacy `media_s3_key` mirror) resolve to the inherited source
 * video from repost-seed, so the "Descript ready" pill is green but the
 * preview keeps showing the source.
 *
 * Per item: move the Descript-rendered row to index 0 and shift every
 * row that was below it up by 1. Two-pass via negative scratch indexes
 * because the (production_item_id, index) unique constraint collides on
 * a direct `SET index = index + 1`. Also re-mirrors the legacy cover
 * columns on `production_items` so anything reading `media_s3_key`
 * outside the simulator (queue cards, list views) sees the rendered clip.
 *
 * Defaults to dry-run.
 *
 *   heroku run --app hubandspoke -- node scripts/backfill-descript-index-0.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-descript-index-0.mjs --apply
 */
import postgres from "postgres";

const DESCRIPT_EXPORT_URL_PREFIX =
  "https://production-273614-media-export.storage.googleapis.com/";

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
  max: 2,
});

async function main() {
  // Affected items: a Descript-rendered row exists, but the lowest one
  // isn't at index 0. Group by item so multi-render items only count once.
  const affected = await sql`
    SELECT
      pim.production_item_id                       AS item_id,
      MIN(pim.index) FILTER (
        WHERE pim.source_url LIKE ${DESCRIPT_EXPORT_URL_PREFIX + "%"}
      )                                            AS descript_idx,
      MIN(pim.index)                               AS lowest_idx
    FROM production_item_media pim
    WHERE pim.production_item_id IN (
      SELECT DISTINCT production_item_id
      FROM production_item_media
      WHERE source_url LIKE ${DESCRIPT_EXPORT_URL_PREFIX + "%"}
    )
    GROUP BY pim.production_item_id
    HAVING MIN(pim.index) FILTER (
      WHERE pim.source_url LIKE ${DESCRIPT_EXPORT_URL_PREFIX + "%"}
    ) > 0
    ORDER BY pim.production_item_id
  `;

  console.log(
    `Mode: ${dryRun ? "DRY RUN" : "APPLY"} · affected items: ${affected.length}`,
  );

  if (affected.length === 0) {
    console.log("Nothing to do.");
    await sql.end();
    return;
  }

  for (const row of affected) {
    const before = await sql`
      SELECT index, kind, LEFT(COALESCE(source_url, ''), 50) AS src
      FROM production_item_media
      WHERE production_item_id = ${row.item_id}
      ORDER BY index ASC
    `;
    console.log(`\n  item=${row.item_id}  descript_idx=${row.descript_idx}`);
    for (const r of before) {
      const tag = r.src.startsWith(DESCRIPT_EXPORT_URL_PREFIX.slice(0, 40))
        ? "DESCRIPT"
        : "source";
      console.log(`    [${r.index}] ${r.kind.padEnd(5)} ${tag}`);
    }
    console.log(`    → after: Descript moves to [0], existing rows shift up`);
  }

  if (dryRun) {
    console.log(`\nDRY RUN — pass --apply to commit.`);
    await sql.end();
    return;
  }

  let fixed = 0;
  for (const row of affected) {
    await sql.begin(async (tx) => {
      // Pass 1: every row below the Descript index goes to negative
      // scratch (encoded as -(index+1) so we can flip back deterministically).
      await tx`
        UPDATE production_item_media
           SET index = -(index + 1)
         WHERE production_item_id = ${row.item_id}
           AND index < ${row.descript_idx}
      `;
      // Pass 2: Descript-rendered row moves to index 0. There may be
      // multiple Descript rows historically (shouldn't, but defense); only
      // the lowest one becomes canonical, rest get pushed to the end.
      await tx`
        UPDATE production_item_media
           SET index = 0
         WHERE production_item_id = ${row.item_id}
           AND source_url LIKE ${DESCRIPT_EXPORT_URL_PREFIX + "%"}
           AND index = ${row.descript_idx}
      `;
      // Pass 3: flip the negative scratch back to positive — rows that
      // were at 0..descript_idx-1 land at 1..descript_idx.
      await tx`
        UPDATE production_item_media
           SET index = -index
         WHERE production_item_id = ${row.item_id}
           AND index < 0
      `;
      // Re-mirror legacy cover columns on production_items so anything
      // reading media_s3_key outside the simulator picks up the rendered
      // clip too. Mirrors descript-publish-and-archive's same step.
      await tx`
        UPDATE production_items pi
           SET media_s3_bucket = m.s3_bucket,
               media_s3_key = m.s3_key,
               media_content_type = m.content_type,
               poster_s3_key = COALESCE(m.poster_s3_key, m.s3_key),
               updated_at = NOW()
          FROM production_item_media m
         WHERE m.production_item_id = pi.id
           AND m.index = 0
           AND pi.id = ${row.item_id}
      `;
    });
    fixed += 1;
    console.log(`  ✓ fixed ${row.item_id}`);
  }

  console.log(`\nFixed ${fixed} item${fixed === 1 ? "" : "s"}.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
