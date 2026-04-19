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
      ADD COLUMN IF NOT EXISTS producer_name text,
      ADD COLUMN IF NOT EXISTS editor_email text,
      ADD COLUMN IF NOT EXISTS editor_notion_user_id text,
      ADD COLUMN IF NOT EXISTS editor_name text
  `;

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'production_items'
      AND column_name IN (
        'producer_name',
        'editor_email',
        'editor_notion_user_id',
        'editor_name'
      )
    ORDER BY column_name
  `;
  console.log(
    "producer/editor columns present:",
    cols.map((c) => c.column_name).join(", ")
  );
} catch (err) {
  console.error("Error:", err);
  process.exit(1);
} finally {
  await sql.end();
}
