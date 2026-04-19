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
      ADD COLUMN IF NOT EXISTS media_s3_bucket text,
      ADD COLUMN IF NOT EXISTS media_s3_key text,
      ADD COLUMN IF NOT EXISTS media_s3_uploaded_at timestamptz,
      ADD COLUMN IF NOT EXISTS media_size_bytes bigint,
      ADD COLUMN IF NOT EXISTS media_content_type text
  `;

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'production_items'
      AND column_name IN (
        'media_s3_bucket',
        'media_s3_key',
        'media_s3_uploaded_at',
        'media_size_bytes',
        'media_content_type'
      )
    ORDER BY column_name
  `;
  console.log(
    "media_s3 columns present:",
    cols.map((c) => c.column_name).join(", ")
  );
} catch (err) {
  console.error("Error:", err);
  process.exit(1);
} finally {
  await sql.end();
}
