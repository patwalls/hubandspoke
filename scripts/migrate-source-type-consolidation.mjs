#!/usr/bin/env node
/**
 * One-shot data migration to consolidate `production_items.source_type` from
 * five values (original / repost / cross_post / clip / repurposed) to four
 * (original / repost / cross_post / repurposed). Pairs with the PR that
 * collapses the enum in code and adds `formats.is_clip_descript_format`.
 *
 * Three phases, each idempotent. Defaults to dry-run; `--apply` commits.
 *
 *   Phase 1: For every brand-default clip format (the hardcoded
 *            PROMOTED_CLIP_FORMAT_BY_BRAND map that used to live in
 *            promote-clip-idea.ts), set formats.is_clip_descript_format=true.
 *            Replaces the old code lookup with a DB flag the format detail
 *            page can toggle going forward.
 *
 *   Phase 2: UPDATE production_items SET source_type='repurposed'
 *            WHERE source_type='clip'. Preserves source_clip_idea_id +
 *            pillar_content_item_id — the clip-triage UI still finds the
 *            attached clip-idea row and renders the same modal.
 *
 *   Phase 3: Reclassify mis-tagged originals: any item whose format is a
 *            derivative (formats.parent_format_id IS NOT NULL) flips to
 *            'repurposed'. Excludes post_type='youtube_long' as belt-and-
 *            suspenders so root YT formats never get caught.
 *
 * Usage:
 *   # Local dry-run (default):
 *   node --env-file=.env.local scripts/migrate-source-type-consolidation.mjs
 *
 *   # Local commit:
 *   node --env-file=.env.local scripts/migrate-source-type-consolidation.mjs --apply
 *
 *   # Heroku:
 *   heroku run --app=hubandspoke node scripts/migrate-source-type-consolidation.mjs
 *   heroku run --app=hubandspoke node scripts/migrate-source-type-consolidation.mjs --apply
 *
 * Re-runs are no-ops once committed.
 */
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// Brand → format-name pairs that historically held PROMOTED_CLIP_FORMAT_BY_BRAND
// in src/lib/services/promote-clip-idea.ts. After this script runs, the flag
// lives on the formats row and code reads it back via getPromotedClipFormat().
const CLIP_DESCRIPT_FORMATS = [
  { brand: "starter-story", name: "Reel: Repackage Section w/ Hook" },
  { brand: "matg", name: "Podcast Clip With Hook" },
  { brand: "my-first-million", name: "Repackage section with hook" },
  { brand: "futurepedia", name: "Repackage section with hook" },
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes("--apply"),
  };
}

function buildSqlClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (looked for .env.local)");
    process.exit(1);
  }
  // Heroku Postgres uses self-signed certs; local pg may run without TLS.
  const ssl =
    process.env.DATABASE_SSL === "off"
      ? false
      : { rejectUnauthorized: false };
  return postgres(url, { ssl, max: 1 });
}

async function phase1FlagFormats(sql, apply) {
  console.log("\n— Phase 1: flag brand-default clip formats —");
  let touched = 0;
  for (const { brand, name } of CLIP_DESCRIPT_FORMATS) {
    const rows = await sql`
      SELECT id, is_clip_descript_format
      FROM formats
      WHERE brand = ${brand}
        AND lower(name) = lower(${name})
    `;
    if (rows.length === 0) {
      console.log(`  [skip] no format ${brand}/"${name}"`);
      continue;
    }
    for (const row of rows) {
      if (row.is_clip_descript_format) {
        console.log(`  [skip] ${brand}/"${name}" already flagged`);
        continue;
      }
      console.log(
        `  ${apply ? "[set]" : "[dry]"} ${brand}/"${name}" → is_clip_descript_format=true`,
      );
      if (apply) {
        await sql`
          UPDATE formats
          SET is_clip_descript_format = true, updated_at = NOW()
          WHERE id = ${row.id}
        `;
      }
      touched++;
    }
  }
  console.log(`  total flagged${apply ? "" : " (preview)"}: ${touched}`);
}

async function phase1bLabelOriginalFormats(sql, apply) {
  console.log("\n— Phase 1b: flag pillar formats as labels_as_original —");
  // Heuristic: a format counts as a pillar / source-of-truth when it is
  // (a) a ROOT format — parent_format_id IS NULL, and
  // (b) has at least one production item with post_type='youtube_long'.
  // Both filters together. Without (a) we over-flagged derivatives like
  // "TMZ" / "Test Clip" that had one mis-typed YT-long item among many
  // non-YT items. Operator can tick more flags by hand on the format
  // detail page; auto-seed is conservative on purpose. Idempotent.
  const rows = await sql`
    SELECT DISTINCT f.id, f.brand, f.name
    FROM formats f
    WHERE f.labels_as_original = false
      AND f.parent_format_id IS NULL
      AND EXISTS (
        SELECT 1 FROM production_items pi
        WHERE lower(pi.format) = lower(f.name)
          AND pi.brand = f.brand
          AND pi.post_type = 'youtube_long'
      )
    ORDER BY f.brand, f.name
  `;
  if (rows.length === 0) {
    console.log("  no candidate pillar formats found");
    return;
  }
  for (const row of rows) {
    console.log(
      `  ${apply ? "[set]" : "[dry]"} ${row.brand}/"${row.name}" → labels_as_original=true`,
    );
  }
  if (!apply) {
    console.log(`  [dry] would flag ${rows.length} formats`);
    return;
  }
  const ids = rows.map((r) => r.id);
  const updated = await sql`
    UPDATE formats
    SET labels_as_original = true, updated_at = NOW()
    WHERE id = ANY(${ids})
    RETURNING id
  `;
  console.log(`  flagged ${updated.length} formats`);
}

async function phase1cFoldPacksIntoSkill(sql, apply) {
  console.log("\n— Phase 1c: fold descript_packs.prompt into formats.instructions —");
  // Migration 0069 also performs this fold inline (atomic with the table
  // drop) so the script's Phase 1c is only meaningful when run against a
  // DB that hasn't yet had 0069 applied. Once 0069 is in, the table is
  // gone — skip cleanly instead of crashing.
  const [existsRow] = await sql`
    SELECT to_regclass('descript_packs') AS tbl
  `;
  if (!existsRow.tbl) {
    console.log(
      "  descript_packs table already dropped (migration 0069 ran) — skipping",
    );
    return;
  }
  const rows = await sql`
    SELECT f.id, f.name, f.brand,
           coalesce(f.instructions, '') AS instructions,
           dp.prompt AS pack_prompt,
           dp.name AS pack_name
    FROM formats f
    JOIN descript_packs dp ON dp.id = f.descript_pack_id
    WHERE dp.prompt IS NOT NULL AND length(trim(dp.prompt)) > 0
    ORDER BY f.brand, f.name
  `;
  if (rows.length === 0) {
    console.log("  no formats with an attached pack — nothing to fold");
    return;
  }
  let touched = 0;
  for (const r of rows) {
    const existing = r.instructions.trim();
    const pack = r.pack_prompt.trim();
    if (existing.includes(pack)) {
      console.log(`  [skip] ${r.brand}/"${r.name}" — Skill already contains the pack prompt`);
      continue;
    }
    const next = existing ? `${existing}\n\n---\n\n${pack}` : pack;
    console.log(
      `  ${apply ? "[set]" : "[dry]"} ${r.brand}/"${r.name}" ← pack "${r.pack_name}" (+${pack.length} chars)`,
    );
    if (apply) {
      await sql`
        UPDATE formats
        SET instructions = ${next}, updated_at = NOW()
        WHERE id = ${r.id}
      `;
    }
    touched++;
  }
  console.log(`  total folded${apply ? "" : " (preview)"}: ${touched}`);
}

async function phase2ClipToRepurposed(sql, apply) {
  console.log("\n— Phase 2: flip source_type='clip' → 'repurposed' —");
  const [pre] = await sql`
    SELECT count(*)::int AS n
    FROM production_items
    WHERE source_type = 'clip'
  `;
  console.log(`  rows currently source_type='clip': ${pre.n}`);
  if (pre.n === 0) {
    console.log("  nothing to do");
    return;
  }
  if (!apply) {
    console.log(`  [dry] would update ${pre.n} rows`);
    return;
  }
  const rows = await sql`
    UPDATE production_items
    SET source_type = 'repurposed', updated_at = NOW()
    WHERE source_type = 'clip'
    RETURNING id
  `;
  console.log(`  updated ${rows.length} rows`);
}

async function phase3ReclassifyOriginals(sql, apply) {
  console.log(
    "\n— Phase 3: reclassify originals in non-pillar formats → repurposed —",
  );

  // Source of truth is now `formats.labels_as_original`: items in any
  // format that is NOT explicitly flagged as a pillar become repurposed.
  // Phase 1b just seeded the obvious pillar formats; the operator can
  // manually tick more on the format detail page and re-run this script
  // for clean idempotent corrections.
  const preview = await sql`
    SELECT pi.brand,
           pi.format,
           count(*)::int AS n
    FROM production_items pi
    JOIN formats f
      ON lower(f.name) = lower(pi.format)
     AND f.brand = pi.brand
    WHERE pi.source_type = 'original'
      AND pi.format IS NOT NULL
      AND pi.brand IS NOT NULL
      AND f.labels_as_original = false
    GROUP BY pi.brand, pi.format
    ORDER BY count(*) DESC
  `;
  if (preview.length === 0) {
    console.log("  no non-pillar originals to flip");
    return;
  }
  console.log("  affected rows by (brand, format):");
  let total = 0;
  for (const r of preview) {
    console.log(`    ${r.brand.padEnd(20)} ${r.format.padEnd(50)} ${r.n}`);
    total += r.n;
  }
  console.log(`  total to flip: ${total}`);

  if (!apply) {
    console.log(`  [dry] would update ${total} rows`);
    return;
  }
  const rows = await sql`
    UPDATE production_items pi
    SET source_type = 'repurposed', updated_at = NOW()
    FROM formats f
    WHERE pi.source_type = 'original'
      AND pi.format IS NOT NULL
      AND pi.brand IS NOT NULL
      AND lower(f.name) = lower(pi.format)
      AND f.brand = pi.brand
      AND f.labels_as_original = false
    RETURNING pi.id
  `;
  console.log(`  updated ${rows.length} rows`);
}

async function summary(sql) {
  console.log("\n— Final source_type distribution —");
  const rows = await sql`
    SELECT source_type, count(*)::int AS n
    FROM production_items
    GROUP BY source_type
    ORDER BY n DESC
  `;
  for (const r of rows) {
    console.log(`  ${(r.source_type ?? "(null)").padEnd(14)} ${r.n}`);
  }
}

async function main() {
  const { apply } = parseArgs();
  console.log(
    apply
      ? "Running in APPLY mode — changes will be committed."
      : "Running in DRY-RUN mode — re-run with --apply to commit.",
  );
  const sql = buildSqlClient();
  try {
    await phase1FlagFormats(sql, apply);
    await phase1bLabelOriginalFormats(sql, apply);
    await phase1cFoldPacksIntoSkill(sql, apply);
    await phase2ClipToRepurposed(sql, apply);
    await phase3ReclassifyOriginals(sql, apply);
    await summary(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
