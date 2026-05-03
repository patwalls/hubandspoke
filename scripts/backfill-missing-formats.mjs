/**
 * One-time backfill: populate production_items.format for rows where it's NULL.
 *
 * Notion sync didn't always set the Format relation, so ~74% of starter-story
 * items have NULL format. The new queue system fixes this going forward — this
 * script just cleans up the historic backlog.
 *
 * Three passes:
 *   0. Skip patterns — `(Backfilled)` auto-sync placeholders, and
 *      `(REPOST ...)` / `[RP ...]` titles (owned by the repost classifier).
 *   1. Literal title match — if a known format name is a substring of the
 *      title (case-insensitive), assign. Longest names tried first to avoid
 *      partial collisions.
 *   2. LLM (gpt-4.1-mini) — picks from the brand's format list or returns
 *      `unknown`. Disk-cached by item id so re-runs are free. We only write
 *      when confidence is high or medium (80%-accuracy target).
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 *
 * Run (dry):   node --env-file=.env.local scripts/backfill-missing-formats.mjs
 * Run (apply): node --env-file=.env.local scripts/backfill-missing-formats.mjs --apply
 * Phase 1:     ... --pass=1
 * One brand:   ... --brand=matg
 * Sample run:  ... --limit=50
 */
import postgres from "postgres";
import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ─── Tunables ────────────────────────────────────────────────────────────
const LLM_MODEL = "gpt-4.1-mini";
const LLM_BATCH_SIZE = 5; // concurrent requests
const MAX_RETRIES = 5;

// ─── Arg parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;
const passArg = args.find((a) => a.startsWith("--pass="))?.split("=")[1] ?? "both";
const brandArg = args.find((a) => a.startsWith("--brand="))?.split("=")[1] ?? "starter-story";
const limitArg = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || null;
const cachePath =
  args.find((a) => a.startsWith("--llm-cache="))?.split("=")[1] ??
  ".format-backfill-llm-cache.json";

if (!["1", "2", "both"].includes(passArg)) {
  console.error(`Invalid --pass value: ${passArg}. Use 1, 2, or both.`);
  process.exit(1);
}

console.log(
  `Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"} | pass=${passArg} | brand=${brandArg}${limitArg ? ` | limit=${limitArg}` : ""}`,
);

// ─── Skip patterns ───────────────────────────────────────────────────────
const SKIP_PATTERNS = [
  /\(Backfilled\)\s*$/i,
  /\(REPOST /i,
  /\[RP /i,
  /\(reposted\)/i,
];

function shouldSkip(title) {
  if (!title) return true;
  return SKIP_PATTERNS.some((re) => re.test(title));
}

// ─── Retry wrapper (same shape as sibling script) ────────────────────────
async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable) throw err;
      const delayMs = Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ─── DB setup ────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run with --env-file=.env.local or set it.");
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

// ─── Load formats + NULL-format items + pillars in one round trip ───────
const formatRows = await sql`
  SELECT name FROM formats WHERE brand = ${brandArg} ORDER BY length(name) DESC
`;
const formatNames = formatRows.map((r) => r.name);
if (formatNames.length === 0) {
  console.error(`No formats found for brand=${brandArg}`);
  await sql.end();
  process.exit(1);
}
console.log(`Loaded ${formatNames.length} formats for brand=${brandArg}.`);

const itemsRaw = limitArg
  ? await sql`
      SELECT pi.id, pi.title, pi.platform, pi.pillar_content_item_id,
             pil.title AS pillar_title, pil.format AS pillar_format
      FROM production_items pi
      LEFT JOIN production_items pil ON pil.id = pi.pillar_content_item_id
      WHERE pi.brand = ${brandArg} AND pi.format IS NULL
      ORDER BY pi.created_at DESC
      LIMIT ${limitArg}
    `
  : await sql`
      SELECT pi.id, pi.title, pi.platform, pi.pillar_content_item_id,
             pil.title AS pillar_title, pil.format AS pillar_format
      FROM production_items pi
      LEFT JOIN production_items pil ON pil.id = pi.pillar_content_item_id
      WHERE pi.brand = ${brandArg} AND pi.format IS NULL
      ORDER BY pi.created_at DESC
    `;
console.log(`${itemsRaw.length} NULL-format items to process.\n`);

// ─── Phase 0: skip ───────────────────────────────────────────────────────
const skipped = [];
const candidates = [];
for (const it of itemsRaw) {
  if (shouldSkip(it.title)) skipped.push(it);
  else candidates.push(it);
}
console.log(`Phase 0: ${skipped.length} skipped (Backfilled / REPOST / RP patterns).`);

// ─── Phase 1: literal title match ────────────────────────────────────────
// Map of id -> { format, via }
const assigned = new Map();
const pass1Samples = [];

if (passArg === "1" || passArg === "both") {
  // formatNames is already sorted longest-first (see SQL above).
  for (const it of candidates) {
    if (assigned.has(it.id)) continue;
    const title = (it.title ?? "").toLowerCase();
    if (!title) continue;
    for (const fmt of formatNames) {
      if (title.includes(fmt.toLowerCase())) {
        assigned.set(it.id, { format: fmt, via: "pass1" });
        if (pass1Samples.length < 15) {
          pass1Samples.push({ title: it.title, format: fmt });
        }
        break;
      }
    }
  }
  const pass1Count = [...assigned.values()].filter((v) => v.via === "pass1").length;
  console.log(`Phase 1 (literal title): ${pass1Count} matches.`);
  for (const s of pass1Samples) {
    console.log(`  ↳ "${s.title.slice(0, 60)}" → ${s.format}`);
  }
}

// ─── Phase 2: LLM classification ─────────────────────────────────────────
let llmCallsMade = 0;
let llmCacheHits = 0;
const pass2Samples = [];
const cache = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};

if (passArg === "2" || passArg === "both") {
  const unassigned = candidates.filter((it) => !assigned.has(it.id));
  console.log(`\nPhase 2 (LLM): ${unassigned.length} items to classify…`);

  if (unassigned.length > 0) {
    if (!process.env.OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY not set — required for pass 2.");
      await sql.end();
      process.exit(1);
    }
    const client = new OpenAI();

    // Stable across the whole run; OpenAI auto-caches system prompts >1024 tokens
    // (the formats list comfortably exceeds that for any real brand).
    const systemPrompt =
      "You classify a single social-media content item by picking the best-fitting format name from an allowed list.\n\n" +
      "Allowed formats (pick one exactly as written, or return 'unknown'):\n" +
      formatNames.map((n) => `  - ${n}`).join("\n") +
      "\n\nRules:\n" +
      "  - Return the EXACT format name from the list (capitalization + punctuation) or 'unknown'.\n" +
      "  - Prefer 'unknown' over a weak guess — correct NULLs beat wrong guesses for this backfill.\n" +
      "  - The pillar hint (when present) is the source video/post this item derives from; " +
      "its format often constrains the derivative's format.\n" +
      "  - High confidence = name strongly matches the title/platform/pillar context. " +
      "Medium = plausible match. Low = a guess.";

    async function askLLM(item) {
      const cached = cache[item.id];
      if (cached) {
        llmCacheHits++;
        return cached;
      }
      const platforms = Array.isArray(item.platform)
        ? item.platform.join(", ")
        : item.platform ?? "—";
      const userText = [
        `Title: ${item.title ?? "—"}`,
        `Platform: ${platforms}`,
        `Pillar title: ${item.pillar_title ?? "—"}`,
        `Pillar format: ${item.pillar_format ?? "—"}`,
        "",
        "Call `pick_format` with the best match or 'unknown'.",
      ].join("\n");

      const response = await withRetry(() =>
        client.chat.completions.create({
          model: LLM_MODEL,
          max_tokens: 256,
          tools: [
            {
              type: "function",
              function: {
                name: "pick_format",
                description: "Classify the item with the best-matching format.",
                parameters: {
                  type: "object",
                  properties: {
                    format: {
                      type: "string",
                      description:
                        "Exact format name from the allowed list, or 'unknown' if none fit.",
                    },
                    confidence: {
                      type: "string",
                      enum: ["high", "medium", "low"],
                    },
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
            { role: "system", content: systemPrompt },
            { role: "user", content: userText },
          ],
        }),
      );

      let verdict = { format: "unknown", confidence: "low" };
      const message = response.choices[0]?.message;
      for (const call of message?.tool_calls ?? []) {
        if (call.type !== "function") continue;
        let input = {};
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          // leave as default
        }
        verdict = {
          format: typeof input.format === "string" ? input.format.trim() : "unknown",
          confidence:
            typeof input.confidence === "string" ? input.confidence : "low",
        };
        break;
      }
      cache[item.id] = verdict;
      llmCallsMade++;
      return verdict;
    }

    const formatSet = new Set(formatNames);

    for (let i = 0; i < unassigned.length; i += LLM_BATCH_SIZE) {
      const slice = unassigned.slice(i, i + LLM_BATCH_SIZE);
      const results = await Promise.all(
        slice.map(async (it) => ({ it, verdict: await askLLM(it) })),
      );
      for (const { it, verdict } of results) {
        const { format, confidence } = verdict;
        if (confidence === "low") continue;
        if (format === "unknown" || !formatSet.has(format)) continue;
        assigned.set(it.id, { format, via: `pass2:${confidence}` });
        if (pass2Samples.length < 15) {
          pass2Samples.push({
            title: it.title,
            platform: Array.isArray(it.platform) ? it.platform.join(",") : it.platform,
            format,
            confidence,
          });
        }
      }
      // Persist cache every batch so a crash doesn't waste spend.
      writeFileSync(cachePath, JSON.stringify(cache, null, 2));

      if ((i + LLM_BATCH_SIZE) % 100 === 0 || i + LLM_BATCH_SIZE >= unassigned.length) {
        console.log(
          `  … processed ${Math.min(i + LLM_BATCH_SIZE, unassigned.length)}/${unassigned.length} ` +
            `(${llmCallsMade} new, ${llmCacheHits} cached)`,
        );
      }
    }
    console.log(
      `\nPhase 2 (LLM): ${[...assigned.values()].filter((v) => v.via.startsWith("pass2")).length} matches. ` +
        `(${llmCallsMade} calls, ${llmCacheHits} cache hits, cache at ${cachePath})`,
    );
    for (const s of pass2Samples) {
      console.log(
        `  ↳ [${s.confidence}] "${(s.title ?? "").slice(0, 50)}" [${s.platform}] → ${s.format}`,
      );
    }
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────
console.log(
  `\nSummary: ${assigned.size} items classified, ${skipped.length} skipped, ` +
    `${candidates.length - assigned.size} left NULL (no confident match).`,
);

if (dryRun) {
  console.log("\nDRY RUN — no writes. Pass --apply to persist.");
} else if (assigned.size > 0) {
  // Pre-filter pillar-format conflicts in JS so the SQL UPDATE never
  // trips uniq_production_items_pillar_format. Filtering at the DB
  // through try/catch turned out not to be reliable — postgres.js can
  // surface the constraint error via an uncaught rejection.
  console.log(`\nPre-filtering pillar-format conflicts…`);
  const takenPairs = new Set(); // key: `${pillarId}::${lower(format)}`
  const existing = await sql`
    SELECT pillar_content_item_id, format
    FROM production_items
    WHERE brand = ${brandArg}
      AND pillar_content_item_id IS NOT NULL
      AND format IS NOT NULL
  `;
  for (const r of existing) {
    takenPairs.add(`${r.pillar_content_item_id}::${(r.format ?? "").toLowerCase()}`);
  }
  const itemsById = new Map(itemsRaw.map((it) => [it.id, it]));
  const toApply = [];
  let pillarConflicts = 0;
  for (const [id, { format }] of assigned) {
    const it = itemsById.get(id);
    const pillarId = it?.pillar_content_item_id ?? null;
    if (pillarId) {
      const key = `${pillarId}::${format.toLowerCase()}`;
      if (takenPairs.has(key)) {
        pillarConflicts++;
        if (pillarConflicts <= 10) {
          console.log(`  ↻ skip ${id}: pillar-format slot already taken → ${format}`);
        }
        continue;
      }
      takenPairs.add(key);
    }
    toApply.push([id, format]);
  }
  console.log(
    `Pre-filter: ${pillarConflicts} pillar-format conflicts skipped. ${toApply.length} updates to apply.`,
  );

  let applied = 0;
  let otherErrors = 0;
  for (const [id, format] of toApply) {
    try {
      await sql`
        UPDATE production_items
        SET format = ${format}, updated_at = NOW()
        WHERE id = ${id} AND format IS NULL
      `;
      applied++;
    } catch (err) {
      otherErrors++;
      console.error(`  ✗ ${id}: ${err?.code ?? ""} ${err?.message ?? err}`);
    }
  }
  console.log(
    `Applied ${applied}. ${pillarConflicts} conflicts pre-filtered, ${otherErrors} other errors.`,
  );
  await sql`
    INSERT INTO sync_logs (sync_type, status, items_updated, completed_at)
    VALUES ('format_backfill', 'completed', ${applied}, NOW())
  `;
}

await sql.end();
