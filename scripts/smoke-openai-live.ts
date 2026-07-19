// Read-only live smoke test for the OpenAI migration (2026-07-19). Exercises
// the real OpenAI API end-to-end WITHOUT mutating any data — safe to run
// against prod via `heroku run --app hubandspoke npx tsx scripts/smoke-openai-live.ts`.
//
// Verifies the three shapes the migration relies on:
//   1. chat.completions forced single tool (the ~9 simple agents)
//   2. Responses API + built-in web_search (draft-agent's novel path)
//   3. the real `generateDraft` against a live prod item (the full loop)
//
// No INSERT/UPDATE anywhere — it only SELECTs an item to feed the agent.

import postgres from "postgres";
import { openai } from "../src/lib/openai";
import { generateDraft } from "../src/lib/draft-agent";
import { getTranscriptForPrompt } from "../src/lib/services/whisper-transcribe";
import { getSchemaForPostType, type PostType } from "../src/lib/platform-field-schemas";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const ssl =
  process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const sql = postgres(url, { max: 1, ssl, prepare: false });

let failures = 0;
function pass(msg: string) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string, err?: unknown) {
  failures++;
  console.error(`  ❌ ${msg}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}`);
}

async function checkChatCompletionsForcedTool() {
  console.log("\n[1] chat.completions forced single tool (simple-agent shape)");
  try {
    const res = await openai().chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 64,
      tools: [
        {
          type: "function",
          function: {
            name: "return_answer",
            description: "Return the answer.",
            parameters: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "return_answer" } },
      messages: [
        { role: "system", content: "Answer in one word via the tool." },
        { role: "user", content: "What color is a clear daytime sky?" },
      ],
    });
    const call = res.choices[0]?.message?.tool_calls?.[0];
    if (call?.type !== "function") throw new Error("no function tool_call returned");
    const parsed = JSON.parse(call.function.arguments) as { answer?: string };
    if (!parsed.answer) throw new Error("empty answer");
    pass(`forced tool returned: ${JSON.stringify(parsed)}`);
  } catch (err) {
    fail("chat.completions forced tool", err);
  }
}

async function checkResponsesWebSearch() {
  console.log("\n[2] Responses API + built-in web_search (draft-agent path)");
  try {
    const res = await openai().responses.create({
      model: "gpt-4.1",
      max_output_tokens: 256,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      input: "In one sentence, what is the most recent news about Starter Story? Use web search.",
    });
    const didSearch = res.output.some((o) => o.type === "web_search_call");
    pass(
      `Responses call ok (status=${res.status}, web_search_call emitted=${didSearch}). ` +
        `output_text: ${(res.output_text ?? "").slice(0, 140).replace(/\n/g, " ")}`,
    );
    if (!didSearch) {
      console.log(
        "  ⚠️  model chose not to search this time (fine — web_search tool was accepted without error, which is what we're verifying).",
      );
    }
  } catch (err) {
    fail("Responses API / web_search", err);
  }
}

async function checkRealDraftGeneration() {
  console.log("\n[3] real generateDraft against a live prod item (read-only)");
  try {
    // Field schema is derived from post_type (getSchemaForPostType), not
    // stored on formats. Pick a transcript-bearing item whose post_type has
    // a schema (x / instagram_* / linkedin / tiktok / …).
    const items = await sql`
      SELECT pi.id, pi.title, pi.format, pi.brand, pi.platform, pi.post_type,
             pi.pillar_content_item_id AS pillar_id
      FROM transcripts tr
      JOIN production_items pi ON pi.id = tr.production_item_id
      WHERE pi.post_type IS NOT NULL
      LIMIT 25
    `;
    const chosen = items
      .map((it) => ({ it, schema: getSchemaForPostType(it.post_type as PostType) }))
      .find((x) => x.schema && x.schema.fields.length > 0);
    if (!chosen) {
      console.log("  (skip) no transcript-bearing item with a schema-backed post_type");
      return;
    }
    const item = chosen.it;
    const fieldSchema = chosen.schema!;
    console.log(
      `  target: ${item.brand} / ${item.title} (post_type=${item.post_type}, id=${item.id})`,
    );

    const [format] = item.format
      ? await sql`SELECT instructions FROM formats WHERE brand = ${item.brand} AND name = ${item.format}`
      : [{ instructions: null }];
    const transcriptSourceId = (item.pillar_id as string | null) ?? (item.id as string);
    const transcript = await getTranscriptForPrompt(transcriptSourceId);
    if (!transcript) {
      console.log("  (skip) transcript vanished");
      return;
    }

    const result = await generateDraft({
      item: {
        id: item.id as string,
        title: item.title as string | null,
        format: item.format as string | null,
        platform: item.platform as string[] | null,
        brand: item.brand as string,
        postType: (item.post_type as string | null) ?? null,
      },
      fieldSchema,
      formatInstructions: (format?.instructions as string | null) ?? null,
      pillarTitle: item.title as string | null,
      substrate: {
        kind: "transcript",
        segmentsMarkdown: transcript.segmentsMarkdown,
        durationSec: transcript.durationSec,
      },
      mediaContext: {
        pillarHasFullVideo: false,
        pillarHasPoster: false,
        platformMode: "none",
        platformAllowedKinds: [],
      },
    });

    const keys = Object.keys(result.content);
    if (keys.length === 0) throw new Error("agent returned empty content");
    pass(`generateDraft returned fields: [${keys.join(", ")}]`);
    for (const [key, value] of Object.entries(result.content)) {
      const preview =
        typeof value === "string"
          ? value.slice(0, 90).replace(/\n/g, " ")
          : Array.isArray(value)
            ? `(${value.length} items)`
            : JSON.stringify(value);
      console.log(`     ${key}: ${preview}`);
    }
    console.log(`     modelUsage: ${JSON.stringify(result.modelUsage)}`);
  } catch (err) {
    fail("generateDraft (Responses API loop)", err);
  }
}

async function main() {
  console.log("OpenAI migration live smoke test (read-only)\n===========================================");
  await checkChatCompletionsForcedTool();
  await checkResponsesWebSearch();
  await checkRealDraftGeneration();
  console.log("\n===========================================");
  if (failures > 0) {
    console.error(`RESULT: ${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("RESULT: all checks passed ✅");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
