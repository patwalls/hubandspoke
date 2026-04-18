/**
 * Rewrite the existing "test clip" format's prompt into the
 * Claude-skill template shape. Promotes any existing prompt text into
 * the "## Clip guidance" section and fills the other sections with
 * sensible defaults the user can refine.
 *
 * Usage:
 *   DATABASE_URL="postgresql://localhost:5432/hubandspoke_development" DATABASE_SSL=off \
 *     node scripts/update-test-clip-skill.mjs
 *
 *   DATABASE_URL="$(heroku config:get DATABASE_URL --app hubandspoke)" \
 *     node scripts/update-test-clip-skill.mjs
 */
import postgres from "postgres";

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
  const rows = await sql`
    SELECT id, name, instructions
    FROM formats
    WHERE content_type = 'repurposed'
      AND (
        name ILIKE '%test%clip%'
        OR name ILIKE '%descript%clip%'
        OR name = 'Test Clip'
        OR name = 'DESCRIPT CLIP!!!'
      )
  `;
  if (rows.length === 0) {
    console.log("No matching test-clip format found. Nothing to update.");
    process.exit(0);
  }

  for (const row of rows) {
    const existingGuidance = (row.instructions || "").trim() || [
      "Look for a single strong quote, a surprising reveal, or a tactical tip.",
      "Start on a clean sentence boundary.",
      "End on a thought-ending beat.",
      "Target length 30–60 seconds.",
    ].join("\n");

    const newPrompt = `## What this format is
Vertical 30–60s highlight clip from the pillar interview.

## Why it works
Strong hook in the first 3s so scrollers stop. A single punchy moment carries the clip. Payoff lands before attention drops.

## Clip guidance
${existingGuidance}

## Avoid
No filler intros. No "so yeah" tail-offs. Skip moments where the speaker is reading from a doc.
`;

    await sql`
      UPDATE formats
      SET instructions = ${newPrompt}, updated_at = now()
      WHERE id = ${row.id}
    `;
    console.log(`Updated: ${row.name} (${row.id})`);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
