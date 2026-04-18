import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };

const sql = postgres(url, { prepare: false, ssl });

try {
  await sql`
    ALTER TABLE production_items
      ADD COLUMN IF NOT EXISTS pillar_content_notion_id text,
      ADD COLUMN IF NOT EXISTS pillar_content_item_id uuid
  `;

  // Self-referencing FK (ON DELETE SET NULL so a deleted pillar doesn't cascade
  // through every derivative). IF NOT EXISTS on constraints needs a DO block.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'production_items_pillar_content_item_id_fkey'
      ) THEN
        ALTER TABLE production_items
          ADD CONSTRAINT production_items_pillar_content_item_id_fkey
          FOREIGN KEY (pillar_content_item_id)
          REFERENCES production_items (id)
          ON DELETE SET NULL;
      END IF;
    END
    $$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_production_items_pillar_notion
      ON production_items (pillar_content_notion_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_production_items_pillar_item
      ON production_items (pillar_content_item_id)
  `;

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'production_items'
      AND column_name IN ('pillar_content_notion_id', 'pillar_content_item_id')
    ORDER BY column_name
  `;
  console.log(
    "columns present:",
    cols.map((c) => c.column_name).join(", ")
  );
} catch (err) {
  console.error("Error:", err);
  process.exit(1);
} finally {
  await sql.end();
}
