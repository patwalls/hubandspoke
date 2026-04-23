import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
});

async function debug() {
  console.log('\n=== PUBLISHED ITEMS BY BRAND ===');
  const publishedByBrand = await sql`
    SELECT brand, COUNT(*) as total, COUNT(CASE WHEN views > 0 THEN 1 END) as with_views
    FROM production_items
    WHERE status = 'Published'
    GROUP BY brand;
  `;
  console.table(publishedByBrand);

  console.log('\n=== PUBLISHED ITEMS WITH VIEWS (FIRST 10) ===');
  const publishedWithViews = await sql`
    SELECT id, title, brand, format, status, views
    FROM production_items
    WHERE status = 'Published' AND views > 0
    LIMIT 10;
  `;
  console.table(publishedWithViews);

  console.log('\n=== FORMATS WITH THRESHOLDS ===');
  const formatsWithThresholds = await sql`
    SELECT id, name, brand, parent_format_id, view_threshold
    FROM formats
    WHERE view_threshold IS NOT NULL
    ORDER BY view_threshold DESC;
  `;
  console.table(formatsWithThresholds);

  console.log('\n=== FORMATS - PARENT/CHILD RELATIONSHIPS ===');
  const formatHierarchy = await sql`
    SELECT
      f.id,
      f.name,
      f.brand,
      f.view_threshold,
      COALESCE(p.name, '(no parent)') as parent_name
    FROM formats f
    LEFT JOIN formats p ON f.parent_format_id = p.id
    WHERE f.view_threshold IS NOT NULL OR p.view_threshold IS NOT NULL
    ORDER BY f.brand, f.name;
  `;
  console.table(formatHierarchy);

  console.log('\n=== REPURPOSE TRIGGERS (LAST 10) ===');
  const triggers = await sql`
    SELECT id, production_item_id, source_format_id, target_format_id, views_at_trigger, created_at
    FROM repurpose_triggers
    ORDER BY created_at DESC
    LIMIT 10;
  `;
  console.table(triggers);

  console.log('\n=== REPURPOSED ITEMS (LAST 10) ===');
  const repurposed = await sql`
    SELECT id, title, brand, format, status, source_type, pillar_content_item_id, created_at
    FROM production_items
    WHERE source_type = 'repurposed'
    ORDER BY created_at DESC
    LIMIT 10;
  `;
  console.table(repurposed);

  console.log('\n=== CASE STUDIES (IF EXIST) ===');
  const caseStudies = await sql`
    SELECT id, title, brand, format, status, views, pillar_content_item_id
    FROM production_items
    WHERE format ILIKE '%case%study%' OR format = 'Case Study'
    LIMIT 20;
  `;
  console.table(caseStudies);

  await sql.end();
}

debug().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
