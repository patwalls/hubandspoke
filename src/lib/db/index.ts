import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// max: 8 keeps the web dyno's postgres.js pool bounded so web + the
// graphile-worker pool on the same dyno (WorkerUtils maxPoolSize=2) fit
// within Heroku Essential-0's 20-connection budget. See CLAUDE.md.
const client = postgres(connectionString, {
  prepare: false,
  max: 8,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});
export const db = drizzle(client, { schema });
