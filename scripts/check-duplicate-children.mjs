import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, { prepare: false });

try {
  const dupes = await sql`
    SELECT
      pillar_content_item_id,
      lower(format) AS format_lower,
      count(*)     AS child_count,
      array_agg(id ORDER BY created_at) AS child_ids,
      array_agg(title ORDER BY created_at) AS child_titles
    FROM production_items
    WHERE pillar_content_item_id IS NOT NULL
      AND format IS NOT NULL
    GROUP BY pillar_content_item_id, lower(format)
    HAVING count(*) > 1
    ORDER BY count(*) DESC
  `;

  if (dupes.length === 0) {
    console.log("No duplicate (pillar, format) pairs found. Safe to apply unique index.");
    process.exit(0);
  }

  console.log(`Found ${dupes.length} duplicate (pillar, format) pair(s):\n`);
  for (const row of dupes) {
    const pillar = await sql`
      SELECT id, title FROM production_items WHERE id = ${row.pillar_content_item_id}
    `;
    const pillarTitle = pillar[0]?.title ?? "(missing pillar)";
    console.log(`Pillar: ${pillarTitle} (${row.pillar_content_item_id})`);
    console.log(`  format=${row.format_lower}  count=${row.child_count}`);
    for (let i = 0; i < row.child_ids.length; i++) {
      console.log(`    - ${row.child_ids[i]}  "${row.child_titles[i] ?? ""}"`);
    }
    console.log();
  }

  console.log("Applying the unique index will fail until these are resolved.");
  process.exit(2);
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
