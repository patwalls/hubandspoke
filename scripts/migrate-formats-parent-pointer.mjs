import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };

const sql = postgres(url, { prepare: false, ssl });

function log(...args) {
  console.log(dryRun ? "[dry-run]" : "[migrate]", ...args);
}

try {
  log(`Starting formats parent-pointer migration${dryRun ? " (dry run)" : ""}`);

  // Step 1: add the column + FK + index (idempotent).
  if (!dryRun) {
    await sql`
      ALTER TABLE formats
        ADD COLUMN IF NOT EXISTS parent_format_id uuid
    `;
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'formats_parent_format_id_fkey'
        ) THEN
          ALTER TABLE formats
            ADD CONSTRAINT formats_parent_format_id_fkey
            FOREIGN KEY (parent_format_id)
            REFERENCES formats (id)
            ON DELETE SET NULL;
        END IF;
      END
      $$
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_formats_parent_format_id
        ON formats (parent_format_id)
    `;
    log("column + FK + index ready");
  } else {
    log("would add parent_format_id column, FK, and index");
  }

  // Step 2: preflight audit — any target listed under multiple sources?
  const duplicates = await sql`
    SELECT
      m.target_format_id,
      f.name AS target_name,
      array_agg(m.source_format_id ORDER BY m.created_at ASC) AS source_ids,
      array_agg(sf.name ORDER BY m.created_at ASC) AS source_names,
      array_agg(m.created_at ORDER BY m.created_at ASC) AS created_ats
    FROM format_repurpose_mappings m
    JOIN formats f ON f.id = m.target_format_id
    JOIN formats sf ON sf.id = m.source_format_id
    GROUP BY m.target_format_id, f.name
    HAVING COUNT(*) > 1
  `;

  if (duplicates.length > 0) {
    log(`WARNING: ${duplicates.length} target(s) linked to multiple sources. Oldest-wins will be applied:`);
    for (const row of duplicates) {
      const pairs = row.source_names.map((n, i) => `${n} (${row.created_ats[i].toISOString()})`).join(", ");
      log(`  target "${row.target_name}" has sources: ${pairs}. Picking: ${row.source_names[0]}`);
    }
  } else {
    log("preflight: no duplicate sources found");
  }

  // Step 3: populate parent_format_id using oldest-wins.
  if (!dryRun) {
    const result = await sql`
      UPDATE formats f
      SET parent_format_id = m.source_format_id
      FROM (
        SELECT DISTINCT ON (target_format_id)
          target_format_id,
          source_format_id
        FROM format_repurpose_mappings
        ORDER BY target_format_id, created_at ASC
      ) m
      WHERE f.id = m.target_format_id
        AND f.parent_format_id IS NULL
      RETURNING f.id
    `;
    log(`populated parent_format_id on ${result.length} format(s)`);
  } else {
    const preview = await sql`
      SELECT COUNT(DISTINCT target_format_id) AS n FROM format_repurpose_mappings
    `;
    log(`would populate parent_format_id on ${preview[0].n} format(s)`);
  }

  // Step 4: orphan check (repurposed with no mapping).
  const orphans = await sql`
    SELECT id, name FROM formats
    WHERE content_type = 'repurposed'
      AND id NOT IN (SELECT target_format_id FROM format_repurpose_mappings)
  `;
  if (orphans.length > 0) {
    log(`${orphans.length} repurposed format(s) with no mapping — will become roots:`);
    for (const row of orphans) log(`  - ${row.name}`);
  } else {
    log("no orphaned repurposed formats");
  }

  // Step 5: cycle preflight (recursive CTE). Only runs after population.
  if (!dryRun) {
    const cycles = await sql`
      WITH RECURSIVE ancestry AS (
        SELECT id, parent_format_id, 1 AS depth, ARRAY[id] AS path
          FROM formats
          WHERE parent_format_id IS NOT NULL
        UNION ALL
        SELECT f.id, f.parent_format_id, a.depth + 1, a.path || f.id
          FROM formats f
          JOIN ancestry a ON f.id = a.parent_format_id
          WHERE NOT (f.id = ANY(a.path))
            AND a.depth < 50
      )
      SELECT id, path FROM ancestry WHERE depth >= 50
    `;
    if (cycles.length > 0) {
      console.error("ABORT: cycle detected in parent_format_id. Investigate:");
      for (const c of cycles) console.error(`  id=${c.id} path=${c.path.join(" -> ")}`);
      process.exit(1);
    }
    log("cycle preflight: clean");

    // Step 6: brand sanity.
    const crossBrand = await sql`
      SELECT f.id AS child_id, f.name AS child_name, f.brand AS child_brand,
             p.id AS parent_id, p.name AS parent_name, p.brand AS parent_brand
      FROM formats f
      JOIN formats p ON f.parent_format_id = p.id
      WHERE f.brand <> p.brand
    `;
    if (crossBrand.length > 0) {
      console.error("ABORT: cross-brand parent/child pairs found:");
      for (const row of crossBrand) {
        console.error(`  ${row.child_name} (${row.child_brand}) -> ${row.parent_name} (${row.parent_brand})`);
      }
      process.exit(1);
    }
    log("brand sanity: clean");
  } else {
    // In dry-run, simulate cycle + brand checks off the mappings table.
    const mappingsCycles = await sql`
      WITH RECURSIVE ancestry AS (
        SELECT target_format_id AS id, source_format_id AS parent_id, 1 AS depth, ARRAY[target_format_id] AS path
          FROM (
            SELECT DISTINCT ON (target_format_id) target_format_id, source_format_id
            FROM format_repurpose_mappings
            ORDER BY target_format_id, created_at ASC
          ) m
        UNION ALL
        SELECT m2.target_format_id, m2.source_format_id, a.depth + 1, a.path || m2.target_format_id
          FROM (
            SELECT DISTINCT ON (target_format_id) target_format_id, source_format_id
            FROM format_repurpose_mappings
            ORDER BY target_format_id, created_at ASC
          ) m2
          JOIN ancestry a ON m2.target_format_id = a.parent_id
          WHERE NOT (m2.target_format_id = ANY(a.path))
            AND a.depth < 50
      )
      SELECT id, path FROM ancestry WHERE depth >= 50
    `;
    if (mappingsCycles.length > 0) {
      console.error("WARNING: cycle detected in oldest-wins mapping graph:");
      for (const c of mappingsCycles) console.error(`  path=${c.path.join(" -> ")}`);
    } else {
      log("cycle preflight (dry-run, off mappings): clean");
    }

    const crossBrandPreview = await sql`
      SELECT f.id AS child_id, f.name AS child_name, f.brand AS child_brand,
             p.name AS parent_name, p.brand AS parent_brand
      FROM (
        SELECT DISTINCT ON (target_format_id) target_format_id, source_format_id
        FROM format_repurpose_mappings
        ORDER BY target_format_id, created_at ASC
      ) m
      JOIN formats f ON f.id = m.target_format_id
      JOIN formats p ON p.id = m.source_format_id
      WHERE f.brand <> p.brand
    `;
    if (crossBrandPreview.length > 0) {
      console.error("WARNING: cross-brand pairs would be written:");
      for (const row of crossBrandPreview) {
        console.error(`  ${row.child_name} (${row.child_brand}) -> ${row.parent_name} (${row.parent_brand})`);
      }
    } else {
      log("brand sanity (dry-run): clean");
    }
  }

  // Step 7 & 8: drop the legacy column + table.
  if (!dryRun) {
    await sql`ALTER TABLE formats DROP COLUMN IF EXISTS content_type`;
    log("dropped formats.content_type");

    await sql`DROP TABLE IF EXISTS format_repurpose_mappings`;
    log("dropped format_repurpose_mappings table");
  } else {
    log("would drop formats.content_type");
    log("would drop format_repurpose_mappings table");
  }

  // Summary — only after population.
  if (!dryRun) {
    const stats = await sql`
      WITH RECURSIVE depths AS (
        SELECT id, name, 1 AS depth FROM formats WHERE parent_format_id IS NULL
        UNION ALL
        SELECT f.id, f.name, d.depth + 1 FROM formats f JOIN depths d ON f.parent_format_id = d.id
      )
      SELECT
        COUNT(*) FILTER (WHERE depth = 1) AS roots,
        COUNT(*) FILTER (WHERE depth > 1) AS derivatives,
        MAX(depth) AS max_depth
      FROM depths
    `;
    log(`post-migration stats: ${stats[0].roots} roots, ${stats[0].derivatives} derivatives, max depth ${stats[0].max_depth}`);
  }

  if (dryRun) log("Dry run complete. Re-run without --dry-run to apply.");
  else log("Migration complete.");
} catch (err) {
  console.error("Error:", err);
  process.exit(1);
} finally {
  await sql.end();
}
