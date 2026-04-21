import postgres from "postgres";
import { config } from "dotenv";
config({ path: ".env.local" });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, ssl: "require" });
const rows = await sql`
  SELECT id, published_link, format, brand, thumbnail
  FROM production_items
  WHERE published_link ~ 'instagram\.com/(p|reel|reels)/[A-Za-z0-9_-]+'
  ORDER BY published_date DESC NULLS LAST
  LIMIT 4
`;
console.log(JSON.stringify(rows, null, 2));
await sql.end();
