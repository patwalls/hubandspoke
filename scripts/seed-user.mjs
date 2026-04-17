/**
 * Seed a user in the new users table.
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-user.mjs <email> <password> [name]
 *
 * Use against Heroku Postgres by exporting DATABASE_URL from heroku:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL --app hubandspoke) \
 *     node scripts/seed-user.mjs pat@example.com 'temp-password'
 */
import postgres from "postgres";
import bcrypt from "bcryptjs";

const [, , emailArg, passwordArg, nameArg] = process.argv;
if (!emailArg || !passwordArg) {
  console.error("Usage: seed-user.mjs <email> <password> [name]");
  process.exit(1);
}

const email = emailArg.toLowerCase().trim();
const password = passwordArg;
const name = nameArg || null;
if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

try {
  const passwordHash = await bcrypt.hash(password, 12);
  const [row] = await sql`
    INSERT INTO users (email, password_hash, name)
    VALUES (${email}, ${passwordHash}, ${name})
    ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          name = COALESCE(EXCLUDED.name, users.name),
          updated_at = now()
    RETURNING id, email
  `;
  console.log(`OK: ${row.email} (${row.id})`);
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
