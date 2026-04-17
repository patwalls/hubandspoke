import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
try {
  const r = await sql`SELECT version()`;
  console.log(r[0].version);
} finally { await sql.end(); }
