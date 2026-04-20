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
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text`;
  await sql`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`;

  const cols = await sql`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name IN ('avatar_url', 'password_hash')
    ORDER BY column_name
  `;
  console.log("users columns:");
  for (const c of cols) console.log(` - ${c.column_name} (nullable=${c.is_nullable})`);
} catch (err) {
  console.error("Error:", err);
  process.exit(1);
} finally {
  await sql.end();
}
