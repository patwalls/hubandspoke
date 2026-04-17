import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = postgres(url, { prepare: false });
try {
  const dbSize = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
  const tables = await sql`
    SELECT relname AS table, n_live_tup AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
    FROM pg_stat_user_tables
    ORDER BY n_live_tup DESC
  `;
  console.log("DB total size:", dbSize[0].size);
  console.log("\nTables:");
  for (const t of tables) console.log(`  ${t.table.padEnd(35)} ${String(t.rows).padStart(10)} rows  ${t.size}`);
  const totalRows = tables.reduce((s, t) => s + Number(t.rows), 0);
  console.log(`\nTotal rows across user tables: ${totalRows.toLocaleString()}`);
} catch (err) { console.error("Error:", err.message); process.exit(1); }
finally { await sql.end(); }
