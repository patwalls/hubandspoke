// Applies pending drizzle migrations. Invoked by `npm run db:migrate`, which
// Heroku runs in the release phase. Uses drizzle-orm's migrator (prod dep) so
// we don't need drizzle-kit installed in production.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };

const client = postgres(url, { max: 1, ssl, prepare: false });

try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  console.log("Migrations applied.");
} catch (err) {
  console.error("Migration failed:", err);
  process.exit(1);
} finally {
  await client.end();
}
