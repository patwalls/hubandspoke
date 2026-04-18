/**
 * Seed a test repurposed format called "Test Clip" and attach it as a
 * repurpose target of the named pillar format.
 *
 * Usage (local):
 *   node --env-file=.env.local scripts/seed-clip-out-test-format.mjs "Business Breakdown"
 *
 * Usage (prod):
 *   DATABASE_URL="$(heroku config:get DATABASE_URL --app hubandspoke)" \
 *     node scripts/seed-clip-out-test-format.mjs "Business Breakdown"
 */
import postgres from "postgres";

const [, , pillarNameArg] = process.argv;
if (!pillarNameArg) {
  console.error("Usage: seed-clip-out-test-format.mjs <pillar format name>");
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

const TEST_CLIP_NAME = "Test Clip";
const TEST_CLIP_PROMPT = `Create a short vertical-friendly highlight clip from the pillar interview.
Pick a punchy moment — a strong quote, a surprising reveal, or a tactical tip.
Start on a clean sentence boundary and end on a thought-ending beat. 30–60 seconds.
Leave natural pauses intact; no filler-word removal needed for this MVP.`;

try {
  const [pillar] = await sql`
    SELECT id, brand, name FROM formats WHERE name = ${pillarNameArg} LIMIT 1
  `;
  if (!pillar) {
    console.error(`Pillar format "${pillarNameArg}" not found.`);
    process.exit(1);
  }
  console.log(`Pillar: ${pillar.name} (${pillar.id}, brand=${pillar.brand})`);

  const [clip] = await sql`
    INSERT INTO formats (name, brand, channels, parent_format_id, descript_clip_prompt)
    VALUES (${TEST_CLIP_NAME}, ${pillar.brand}, ${sql.json(["Instagram Reel"])}, ${pillar.id}, ${TEST_CLIP_PROMPT})
    ON CONFLICT (name) DO UPDATE
      SET descript_clip_prompt = EXCLUDED.descript_clip_prompt,
          parent_format_id = EXCLUDED.parent_format_id,
          updated_at = now()
    RETURNING id, name
  `;
  console.log(`Test Clip format: ${clip.name} (${clip.id}) — parent=${pillar.name}`);
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
