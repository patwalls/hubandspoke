/**
 * Smoke test the OpenAI migrations end-to-end. Calls each migrated agent
 * with a small synthetic input, prints the verdict, and totals up tokens
 * used. Cost is well under $0.10 for a full run.
 *
 * Run: npx tsx --env-file=.env.local scripts/smoke-openai-migrations.ts
 */
import { openai } from "../src/lib/openai";
import { dispatchRepurpose } from "../src/lib/repurpose-agent";
import {
  classifyEvergreen,
  judgeRepostFit,
} from "../src/lib/evergreen-agent";
import { classifyCrossPostFit } from "../src/lib/services/cross-post-fit-classifier";

let totalPrompt = 0;
let totalCompletion = 0;
const failures: string[] = [];

function logOk(name: string, summary: string) {
  console.log(`✅ ${name}`);
  console.log(`   ${summary}`);
}
function logFail(name: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`❌ ${name}`);
  console.log(`   ${msg}`);
  failures.push(name);
}

async function testKeyAndPlainChat() {
  const name = "1. plain chat completion (summary-route pattern)";
  try {
    const resp = await openai().chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 60,
      messages: [
        { role: "system", content: "Reply in exactly 5 words. No punctuation." },
        { role: "user", content: "Confirm the OpenAI key is working." },
      ],
    });
    totalPrompt += resp.usage?.prompt_tokens ?? 0;
    totalCompletion += resp.usage?.completion_tokens ?? 0;
    const text = resp.choices[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error("empty response");
    logOk(name, `→ "${text}"`);
  } catch (err) {
    logFail(name, err);
  }
}

async function testRepurpose() {
  const name = "2. repurpose-agent (two-tool dispatch)";
  try {
    const result = await dispatchRepurpose({
      itemTitle: "How I built a $1M SaaS in 12 months",
      targetFormatName: "Repackage Section w/ Hook",
      targetPrompt: `## What this format is\nA short-form Reel (30-60 sec) that pulls one specific lesson from the long-form interview and frames it with a designed text overlay.\n\n## Clip guidance\nFind one moment where the founder describes a single concrete tactic.\n\n## Avoid\nAvoid intros and outros.`,
    });
    if (result.kind !== "descript_clip") {
      throw new Error(`expected descript_clip for clip-style skill, got ${result.kind}`);
    }
    logOk(name, `→ kind=${result.kind}, comp="${result.compositionName}"`);
  } catch (err) {
    logFail(name, err);
  }

  const name2 = "3. repurpose-agent (manual_task path)";
  try {
    const result = await dispatchRepurpose({
      itemTitle: "How I built a $1M SaaS in 12 months",
      targetFormatName: "Carousel Post",
      targetPrompt: `## What this format is\nAn Instagram carousel of 5-8 designed slides made in Canva using brand templates. Editor builds each slide manually.`,
    });
    if (result.kind !== "manual_task") {
      throw new Error(`expected manual_task for Canva-style skill, got ${result.kind}`);
    }
    logOk(name2, `→ kind=${result.kind}, name="${result.taskName}"`);
  } catch (err) {
    logFail(name2, err);
  }
}

async function testEvergreen() {
  const name = "4. classifyEvergreen (evergreen post)";
  try {
    const v = await classifyEvergreen({
      title: "The 3 mental models I use when pricing a new SaaS product",
      postType: "x",
      publishedDate: "2025-08-14",
      contentBody:
        "Three frameworks I think about every time I price a new product: value-based pricing, competitor anchoring, and willingness-to-pay tests. Each one teaches you a different thing about your customer.",
    });
    if (!v.isEvergreen) throw new Error(`expected evergreen, got not-evergreen: ${v.reasoning}`);
    logOk(name, `→ isEvergreen=${v.isEvergreen}: ${v.reasoning.slice(0, 100)}`);
  } catch (err) {
    logFail(name, err);
  }

  const name2 = "5. classifyEvergreen (not-evergreen post)";
  try {
    const v = await classifyEvergreen({
      title: "Black Friday flash sale ends tonight — 50% off through midnight EST",
      postType: "instagram_post",
      publishedDate: "2025-11-29",
      contentBody:
        "Last chance to grab the course at 50% off. Sale ends at midnight EST tonight, November 29 2025. Use code BF50.",
    });
    if (v.isEvergreen) throw new Error(`expected not-evergreen, got evergreen: ${v.reasoning}`);
    logOk(name2, `→ isEvergreen=${v.isEvergreen}: ${v.reasoning.slice(0, 100)}`);
  } catch (err) {
    logFail(name2, err);
  }

  const name3 = "6. judgeRepostFit";
  try {
    const v = await judgeRepostFit({
      title: "The 3 mental models I use when pricing a new SaaS product",
      postType: "x",
      publishedDate: "2025-08-14",
      contentBody: "Three frameworks I think about every time I price a new product…",
      pastKillReasons: [
        { reason: "too generic — pricing advice without a specific story", postType: "x" },
      ],
      pastAcceptExemplars: [
        { title: "Mental models for hiring your first 5 engineers", postType: "x", format: "Thread" },
      ],
    });
    logOk(name3, `→ wouldRepost=${v.wouldRepost}: ${v.reasoning.slice(0, 100)}`);
  } catch (err) {
    logFail(name3, err);
  }
}

async function testCrossPostFit() {
  const name = "7. classifyCrossPostFit (good fit)";
  try {
    const v = await classifyCrossPostFit({
      title: "Three pricing mental models",
      contentBody:
        "Three frameworks I think about every time I price a new product: value-based pricing, competitor anchoring, and willingness-to-pay tests. Useful for any SaaS founder.",
      sourcePlatform: "x",
      targetPlatform: "linkedin",
      publishedDate: "2025-08-14",
      hasVideo: false,
      hasImage: false,
    });
    logOk(name, `→ isGoodFit=${v.isGoodFit}, fallback=${v.isFallback}: ${v.reasoning.slice(0, 100)}`);
  } catch (err) {
    logFail(name, err);
  }

  const name2 = "8. classifyCrossPostFit (medium mismatch — video on linkedin-status target)";
  try {
    const v = await classifyCrossPostFit({
      title: "Behind the scenes Reel",
      contentBody:
        "Watch the founder walk through the warehouse — full video on Instagram Reels. Plays best with sound on.",
      sourcePlatform: "instagram_reel",
      targetPlatform: "threads",
      publishedDate: "2025-08-14",
      hasVideo: true,
      hasImage: false,
    });
    logOk(name2, `→ isGoodFit=${v.isGoodFit}, fallback=${v.isFallback}: ${v.reasoning.slice(0, 100)}`);
  } catch (err) {
    logFail(name2, err);
  }
}

async function testVisionCallPattern() {
  const name = "9. vision call pattern (hook-extract dispatcher style)";
  try {
    // Tiny public image — Wikipedia favicon-style placeholder. Single test
    // to confirm the image_url content shape and gpt-4.1-mini vision support.
    const resp = await openai().chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content: "Describe the image in one short sentence. No preamble.",
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: "https://picsum.photos/seed/hubandspoke/240/240",
              },
            },
            { type: "text", text: "What's in this image?" },
          ],
        },
      ],
    });
    totalPrompt += resp.usage?.prompt_tokens ?? 0;
    totalCompletion += resp.usage?.completion_tokens ?? 0;
    const text = resp.choices[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error("empty response");
    logOk(name, `→ "${text.slice(0, 100)}"`);
  } catch (err) {
    logFail(name, err);
  }
}

async function testStructuredFunctionCallPattern() {
  const name = "10. function calling with strict schema (backfill-formats pattern)";
  try {
    const resp = await openai().chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 60,
      tools: [
        {
          type: "function",
          function: {
            name: "pick_format",
            description: "Pick the best format from the allowed list, or 'unknown'.",
            parameters: {
              type: "object",
              properties: {
                format: { type: "string" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["format", "confidence"],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "pick_format" } },
      messages: [
        {
          role: "system",
          content:
            "Allowed formats: Repackage Section w/ Hook, Quote Card, Carousel Post. Pick exactly one or 'unknown'.",
        },
        { role: "user", content: "Title: 'How I built a SaaS' — Platform: instagram_reel" },
      ],
    });
    totalPrompt += resp.usage?.prompt_tokens ?? 0;
    totalCompletion += resp.usage?.completion_tokens ?? 0;
    const call = resp.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== "function") throw new Error("no function call");
    const parsed = JSON.parse(call.function.arguments);
    if (!parsed.format || !parsed.confidence) throw new Error(`bad shape: ${JSON.stringify(parsed)}`);
    logOk(name, `→ ${JSON.stringify(parsed)}`);
  } catch (err) {
    logFail(name, err);
  }
}

async function main() {
  console.log("Smoke-testing OpenAI migrations against gpt-4.1-mini\n");
  await testKeyAndPlainChat();
  await testRepurpose();
  await testEvergreen();
  await testCrossPostFit();
  await testVisionCallPattern();
  await testStructuredFunctionCallPattern();

  // gpt-4.1-mini pricing (per Jan 2026 cutoff): $0.40/1M input, $1.60/1M output.
  const inputCost = (totalPrompt / 1_000_000) * 0.4;
  const outputCost = (totalCompletion / 1_000_000) * 1.6;
  console.log(
    `\nDirect-call token totals (excludes the agent functions, which manage their own usage):`,
  );
  console.log(`  prompt:     ${totalPrompt}`);
  console.log(`  completion: ${totalCompletion}`);
  console.log(`  est. cost:  $${(inputCost + outputCost).toFixed(5)}`);
  console.log(
    `\n${failures.length === 0 ? "🟢 All smoke tests passed" : `🔴 ${failures.length} failed: ${failures.join(", ")}`}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke runner crashed:", err);
  process.exit(1);
});
