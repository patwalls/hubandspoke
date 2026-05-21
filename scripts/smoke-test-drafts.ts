// Stage-1 end-to-end smoke test. Exercises the real generate flow against
// whichever item already has a transcript in the local DB — runs the
// Anthropic call, performs the transactional demote+insert, regenerates, and
// asserts the partial unique index holds.
//
// Costs ~$0.002 of Haiku tokens per run. Do not add to CI.
//
// Usage: npx tsx --env-file=.env.local scripts/smoke-test-drafts.ts

import postgres from "postgres";
import { generateDraft, GENERATED_BY, PROMPT_VERSION } from "../src/lib/draft-agent";
import { getTranscriptForPrompt } from "../src/lib/services/whisper-transcribe";
import type { FormatFieldSchema } from "../src/lib/db/schema";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const sql = postgres(url, { max: 1, ssl, prepare: false });

async function countCurrentDrafts(itemId: string): Promise<number> {
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM content_drafts
    WHERE production_item_id = ${itemId} AND is_current = true
  `;
  return n as number;
}

async function latestVersion(itemId: string): Promise<number> {
  const [row] = await sql`
    SELECT version FROM content_drafts
    WHERE production_item_id = ${itemId}
    ORDER BY version DESC LIMIT 1
  `;
  return (row?.version as number | undefined) ?? 0;
}

async function main() {
  const [item] = await sql`
    SELECT pi.id, pi.title, pi.format, pi.brand, pi.platform,
           pi.pillar_content_item_id AS pillar_id
    FROM transcripts tr
    JOIN production_items pi ON pi.id = tr.production_item_id
    JOIN formats f ON f.name = pi.format AND f.brand = pi.brand
    WHERE f.field_schema IS NOT NULL
    LIMIT 1
  `;
  if (!item) {
    console.log(
      "No item with both a transcript and a format-with-field-schema — skipping.",
    );
    process.exit(0);
  }

  console.log(
    `Target: ${item.brand} / ${item.title} (format=${item.format}, id=${item.id})`,
  );

  const startingVersion = await latestVersion(item.id);
  console.log(`Starting latest version: ${startingVersion}`);

  const [format] = await sql`
    SELECT instructions, field_schema FROM formats
    WHERE brand = ${item.brand} AND name = ${item.format}
  `;
  const fieldSchema = format.field_schema as FormatFieldSchema;

  const transcriptSourceId = (item.pillar_id as string | null) ?? item.id;
  const transcript = await getTranscriptForPrompt(transcriptSourceId);
  if (!transcript) {
    console.error("Unexpected: transcript disappeared between queries.");
    process.exit(1);
  }

  console.log("Calling draft-agent…");
  const result = await generateDraft({
    item: {
      id: item.id,
      title: item.title,
      format: item.format,
      platform: item.platform as string[] | null,
      brand: item.brand,
      postType: item.post_type ?? null,
    },
    fieldSchema,
    formatInstructions: format.instructions,
    pillarTitle: item.title,
    substrate: {
      kind: "transcript",
      segmentsMarkdown: transcript.segmentsMarkdown,
      durationSec: transcript.durationSec,
    },
    // Smoke script doesn't exercise the V1.1 media path — feed a minimal
    // MediaContext that nudges the agent toward `media_action: "none"`.
    mediaContext: {
      pillarHasFullVideo: false,
      pillarHasPoster: false,
      platformMode: "none",
      platformAllowedKinds: [],
    },
  });

  console.log(
    `Agent returned content keys: [${Object.keys(result.content).join(", ")}]`,
  );
  for (const [key, value] of Object.entries(result.content)) {
    const preview =
      typeof value === "string"
        ? value.slice(0, 80).replace(/\n/g, " ")
        : Array.isArray(value)
          ? `(${value.length} items)`
          : JSON.stringify(value);
    console.log(`  ${key}: ${preview}`);
  }
  console.log(`Model usage: ${JSON.stringify(result.modelUsage)}`);

  await sql.begin(async (tx) => {
    await tx`
      UPDATE content_drafts SET is_current = false, updated_at = now()
      WHERE production_item_id = ${item.id} AND is_current = true
    `;
    await tx`
      INSERT INTO content_drafts
        (production_item_id, version, is_current, content,
         field_schema_snapshot, generated_by, prompt_version, model_usage)
      VALUES
        (${item.id}, ${startingVersion + 1}, true, ${sql.json(result.content)},
         ${sql.json(fieldSchema)}, ${GENERATED_BY}, ${PROMPT_VERSION},
         ${sql.json(result.modelUsage)})
    `;
  });

  const afterFirst = await countCurrentDrafts(item.id);
  const ver1 = await latestVersion(item.id);
  console.log(`After first insert: current=${afterFirst}, latest version=${ver1}`);
  if (afterFirst !== 1) {
    console.error("FAIL: expected exactly 1 current draft after first insert");
    process.exit(1);
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE content_drafts SET is_current = false, updated_at = now()
      WHERE production_item_id = ${item.id} AND is_current = true
    `;
    await tx`
      INSERT INTO content_drafts
        (production_item_id, version, is_current, content,
         field_schema_snapshot, generated_by, prompt_version, model_usage)
      VALUES
        (${item.id}, ${ver1 + 1}, true, ${sql.json({ smoke: "regenerate" })},
         ${sql.json(fieldSchema)}, 'smoke-test', 1, ${sql.json({})})
    `;
  });

  const afterRegen = await countCurrentDrafts(item.id);
  const ver2 = await latestVersion(item.id);
  console.log(`After regenerate: current=${afterRegen}, latest version=${ver2}`);
  if (afterRegen !== 1) {
    console.error("FAIL: partial unique index did not enforce single current");
    process.exit(1);
  }
  if (ver2 !== ver1 + 1) {
    console.error(`FAIL: expected version ${ver1 + 1}, got ${ver2}`);
    process.exit(1);
  }

  console.log("Asserting partial unique index rejects a 2nd current row…");
  let rejected = false;
  try {
    await sql`
      INSERT INTO content_drafts
        (production_item_id, version, is_current, content,
         field_schema_snapshot, generated_by)
      VALUES
        (${item.id}, ${ver2 + 1}, true, ${sql.json({})},
         ${sql.json(fieldSchema)}, 'smoke-test-violation')
    `;
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      rejected = true;
      console.log(`  OK — PG rejected with unique_violation (${pgErr.code})`);
    } else {
      console.error("Unexpected error kind:", err);
      process.exit(1);
    }
  }
  if (!rejected) {
    console.error("FAIL: a second is_current=true row was allowed to insert");
    process.exit(1);
  }

  console.log("\nAll assertions passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
