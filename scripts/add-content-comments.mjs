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
    CREATE TABLE IF NOT EXISTS content_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content_item_id uuid NOT NULL REFERENCES production_items(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      body text NOT NULL,
      edited_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_content_comments_item_created
      ON content_comments (content_item_id, created_at)
  `;

  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'content_comments'
    ORDER BY ordinal_position
  `;
  console.log("content_comments columns:");
  for (const c of cols) {
    console.log(` - ${c.column_name} ${c.data_type} (nullable=${c.is_nullable})`);
  }
} catch (err) {
  console.error("Error:", err);
  process.exit(1);
} finally {
  await sql.end();
}
