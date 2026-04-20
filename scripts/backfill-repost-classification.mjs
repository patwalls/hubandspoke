/**
 * One-time backfill: reclassify historic reposts.
 *
 * Finds production_items that are the *same post* republished on the *same
 * platform* and marks the later occurrences as sourceType = "repost",
 * wiring repostedFromItemId back to the earliest occurrence. Originals that
 * end up with >=1 confirmed repost are stamped isEvergreen = true with a
 * reasoning string noting the repost count, which short-circuits the daily
 * AI classifier (the team re-running it is stronger signal than the model).
 *
 * Two passes:
 *   1. Deterministic: same brand + same normalized title + >=1 platform overlap.
 *   2. LLM: Jaccard-filtered near-matches, confirmed via Claude Haiku tool-use.
 *      Cached to disk (keyed by sorted pair of item IDs) so re-runs are free.
 *
 * Defaults to --dry-run. Pass --apply to actually write.
 *
 * Run (dry):   node --env-file=.env.local scripts/backfill-repost-classification.mjs
 * Run (apply): node --env-file=.env.local scripts/backfill-repost-classification.mjs --apply
 * Skip LLM:    ... --pass=1
 * One brand:   ... --brand=starter-story
 */
import postgres from "postgres";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ─── Tunables ────────────────────────────────────────────────────────────
const JACCARD_THRESHOLD = 0.5;
const LLM_MODEL = "claude-haiku-4-5";
const LLM_BATCH_SIZE = 5; // concurrent requests (stay under per-key concurrent limit)
const MAX_LLM_PAIRS = 2000; // safety cap per run
const LEN_RATIO_MAX = 1.5; // skip pairs whose titles differ in length by >1.5x
const MAX_RETRIES = 5;

// ─── Arg parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = !apply;
const passArg = args.find((a) => a.startsWith("--pass="))?.split("=")[1] ?? "both";
const brandArg = args.find((a) => a.startsWith("--brand="))?.split("=")[1] ?? null;
const cachePath =
  args.find((a) => a.startsWith("--llm-cache="))?.split("=")[1] ??
  ".repost-llm-cache.json";

if (!["1", "2", "both"].includes(passArg)) {
  console.error(`Invalid --pass value: ${passArg}. Use 1, 2, or both.`);
  process.exit(1);
}

console.log(
  `Mode: ${dryRun ? "DRY RUN (use --apply to write)" : "APPLY"} | pass=${passArg}` +
    (brandArg ? ` | brand=${brandArg}` : "")
);

// ─── Utilities ───────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "for", "to", "in", "on", "at",
  "by", "with", "from", "is", "was", "are", "were", "i", "my", "me", "you",
  "your", "this", "that", "it", "its", "as", "be", "have", "has", "had",
]);

/** Lowercase, strip emoji, collapse whitespace, trim trailing punctuation. */
function normalizeTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/[.,!?;:"'`~\-–—()[\]{}]+$/g, "")
    .trim();
}

/** Word tokens with stopwords removed, for Jaccard. */
function tokenize(title) {
  const norm = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return new Set();
  return new Set(norm.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function isoDate(d) {
  if (!d) return "(no date)";
  // Postgres `date` columns come back as JS Date at local midnight; format as YYYY-MM-DD.
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/** Earliest-first comparator: publishedDate asc, then createdAt asc. */
function cmpEarliest(a, b) {
  const ad = isoDate(a.published_date);
  const bd = isoDate(b.published_date);
  if (ad !== bd) return ad < bd ? -1 : 1;
  const ac = a.created_at?.getTime?.() ?? Infinity;
  const bc = b.created_at?.getTime?.() ?? Infinity;
  return ac - bc;
}

function pairKey(idA, idB) {
  return idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
}

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

// ─── DB load ─────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run with --env-file=.env.local or set it.");
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL);

// status='Published' + published_date NOT NULL mirror the evergreen-scan service
// (src/lib/services/evergreen-scan.ts:61). Also excludes:
//   - Template/draft rows like "Share Full YT Video" (no publish date).
//   - Bulk Twitter import summaries like "Twitter - September 11, 2025 (Backfilled)"
//     which are one-per-day import artifacts, not real content.
const items = brandArg
  ? await sql`
      SELECT id, title, platform, brand, published_date, created_at,
             source_type, reposted_from_item_id, is_evergreen
      FROM production_items
      WHERE source_type = 'original'
        AND status = 'Published'
        AND published_date IS NOT NULL
        AND title IS NOT NULL
        AND title <> ''
        AND title NOT ILIKE '%(Backfilled)%'
        AND brand = ${brandArg}
    `
  : await sql`
      SELECT id, title, platform, brand, published_date, created_at,
             source_type, reposted_from_item_id, is_evergreen
      FROM production_items
      WHERE source_type = 'original'
        AND status = 'Published'
        AND published_date IS NOT NULL
        AND title IS NOT NULL
        AND title <> ''
        AND title NOT ILIKE '%(Backfilled)%'
    `;

console.log(`Loaded ${items.length} originals from DB.`);

// Precompute normalized title + token set per item.
for (const it of items) {
  it._norm = normalizeTitle(it.title);
  it._tokens = tokenize(it.title);
  it._platforms = Array.isArray(it.platform) ? it.platform : [];
}

// Queue of updates to apply: Map<itemId, { repostedFromItemId }>.
const repostUpdates = new Map();

// ─── Pass 1: deterministic ───────────────────────────────────────────────
let pass1Count = 0;
const pass1Samples = [];
if (passArg === "1" || passArg === "both") {
  const groups = new Map(); // key: `${brand}::${normalized}` -> items[]
  for (const it of items) {
    if (!it._norm || it._platforms.length === 0) continue;
    const key = `${it.brand}::${it._norm}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(it);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(cmpEarliest);
    const earliest = group[0];
    const earliestPlatforms = new Set(earliest._platforms);

    for (let i = 1; i < group.length; i++) {
      const cand = group[i];
      // require >=1 platform overlap with earliest
      const overlap = cand._platforms.some((p) => earliestPlatforms.has(p));
      if (!overlap) continue;
      if (repostUpdates.has(cand.id)) continue;
      repostUpdates.set(cand.id, { repostedFromItemId: earliest.id, via: "pass1" });
      pass1Count++;
    }
    // One sample per distinct match group, so the output isn't dominated by
    // a single repeated title.
    if (pass1Samples.length < 20) {
      pass1Samples.push({
        title: earliest.title,
        platforms: earliest._platforms,
        groupSize: group.length,
        earliestDate: earliest.published_date,
        latestDate: group[group.length - 1].published_date,
      });
    }
  }

  console.log(`\nPass 1 (deterministic): ${pass1Count} items would be reclassified as reposts.`);
  console.log(`Top ${pass1Samples.length} distinct repost groups by title:`);
  for (const s of pass1Samples.sort((a, b) => b.groupSize - a.groupSize)) {
    console.log(
      `  ↳ ${s.groupSize}× "${(s.title ?? "").slice(0, 60)}" [${s.platforms.join(", ")}] ` +
        `${isoDate(s.earliestDate)} → ${isoDate(s.latestDate)}`
    );
  }
}

// ─── Pass 2: LLM near-matches ────────────────────────────────────────────
let pass2Count = 0;
let llmCallsMade = 0;
let llmCacheHits = 0;
const pass2Samples = [];
const cache = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};

if (passArg === "2" || passArg === "both") {
  // Bucket remaining unmatched originals by (brand, platform). An item with
  // multiple platforms lands in every bucket.
  const unmatched = items.filter((it) => !repostUpdates.has(it.id));
  const buckets = new Map(); // key: `${brand}::${platform}` -> items[]
  for (const it of unmatched) {
    if (it._tokens.size === 0) continue;
    for (const p of it._platforms) {
      const key = `${it.brand}::${p}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(it);
    }
  }

  // Collect candidate pairs above Jaccard threshold.
  const candidates = []; // [{ a, b, jaccard, bucketKey }]
  const seenPairs = new Set();
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        // Skip exact normalized matches (already handled by Pass 1).
        if (a._norm && a._norm === b._norm) continue;
        // Length-ratio short-circuit — avoids computing Jaccard for obvious misses.
        const la = a.title.length, lb = b.title.length;
        const ratio = la > lb ? la / lb : lb / la;
        if (ratio > LEN_RATIO_MAX) continue;
        const jac = jaccard(a._tokens, b._tokens);
        if (jac < JACCARD_THRESHOLD) continue;
        const key = pairKey(a.id, b.id);
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        candidates.push({ a, b, jaccard: jac, bucketKey });
      }
    }
  }

  candidates.sort((x, y) => y.jaccard - x.jaccard);
  const totalCandidates = candidates.length;
  const working = candidates.slice(0, MAX_LLM_PAIRS);
  if (totalCandidates > MAX_LLM_PAIRS) {
    console.warn(
      `\nPass 2: ${totalCandidates} candidate pairs exceed MAX_LLM_PAIRS (${MAX_LLM_PAIRS}). ` +
        `Evaluating the top ${MAX_LLM_PAIRS} by Jaccard — re-run after applying to pick up the rest.`
    );
  } else {
    console.log(`\nPass 2: ${totalCandidates} candidate pairs above Jaccard ${JACCARD_THRESHOLD}.`);
  }

  const client = new Anthropic();

  async function askLLM(a, b) {
    const key = pairKey(a.id, b.id);
    if (key in cache) {
      llmCacheHits++;
      return cache[key];
    }
    const earlier = cmpEarliest(a, b) <= 0 ? a : b;
    const later = earlier === a ? b : a;
    const userMessage = [
      `Brand: ${earlier.brand}`,
      `Platform context: same platform (one of ${earlier._platforms.join(", ")})`,
      ``,
      `Post A (earlier, published ${isoDate(earlier.published_date)}):`,
      `  "${earlier.title}"`,
      ``,
      `Post B (later, published ${isoDate(later.published_date)}):`,
      `  "${later.title}"`,
      ``,
      `Are these the same piece of content republished on the same platform, or two different posts? Call exactly one tool.`,
    ].join("\n");

    const response = await withRetry(() => client.messages.create({
      model: LLM_MODEL,
      max_tokens: 256,
      system:
        "You decide whether two social-media post titles from the same brand and same platform are the same piece of content re-run (a repost), or two distinct posts. A repost is the same core idea/story presented with only minor rewording. If the angle, claim, or subject actually differs — even subtly — they are NOT the same post. When uncertain, call `not_same_post`: false positives pollute the repost graph, false negatives only miss a link.",
      tools: [
        {
          name: "same_post",
          description:
            "The two titles describe the same piece of content (same story, same claim, same core idea), republished on the same platform with at most minor rewording.",
          input_schema: {
            type: "object",
            properties: {
              reasoning: { type: "string", description: "One sentence on why these are the same post." },
            },
            required: ["reasoning"],
          },
        },
        {
          name: "not_same_post",
          description:
            "The two titles describe different posts (different angle, claim, subject, or structure), even if they share vocabulary.",
          input_schema: {
            type: "object",
            properties: {
              reasoning: { type: "string", description: "One sentence on why these are different posts." },
            },
            required: ["reasoning"],
          },
        },
      ],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: userMessage }],
    }));

    let verdict = { same: false, reasoning: "malformed response; treated as not-same" };
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      const reasoning = typeof input.reasoning === "string" ? input.reasoning.trim() : "";
      if (block.name === "same_post") verdict = { same: true, reasoning };
      else if (block.name === "not_same_post") verdict = { same: false, reasoning };
      break;
    }
    cache[key] = verdict;
    llmCallsMade++;
    return verdict;
  }

  // Process in parallel batches.
  for (let i = 0; i < working.length; i += LLM_BATCH_SIZE) {
    const slice = working.slice(i, i + LLM_BATCH_SIZE);
    const results = await Promise.all(
      slice.map(async (pair) => ({ pair, verdict: await askLLM(pair.a, pair.b) }))
    );
    for (const { pair, verdict } of results) {
      if (!verdict.same) continue;
      const earlier = cmpEarliest(pair.a, pair.b) <= 0 ? pair.a : pair.b;
      const later = earlier === pair.a ? pair.b : pair.a;
      // If the "later" item is itself already a repost (via Pass 1 or a prior
      // Pass 2 match), skip — it's already linked. If the "earlier" item is
      // a pass-1 repost, link through to its original so the graph stays flat.
      if (repostUpdates.has(later.id)) continue;
      let targetOriginalId = earlier.id;
      if (repostUpdates.has(earlier.id)) {
        targetOriginalId = repostUpdates.get(earlier.id).repostedFromItemId;
      }
      repostUpdates.set(later.id, { repostedFromItemId: targetOriginalId, via: "pass2" });
      pass2Count++;
      if (pass2Samples.length < 10) {
        pass2Samples.push({
          later: later.title,
          earlier: earlier.title,
          jaccard: pair.jaccard,
          reasoning: verdict.reasoning,
        });
      }
    }
    // Persist cache every batch so a crash doesn't lose spend.
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }

  console.log(
    `\nPass 2 (LLM): ${pass2Count} additional items would be reclassified. ` +
      `(${llmCallsMade} new calls, ${llmCacheHits} cached hits, cache at ${cachePath})`
  );
  for (const s of pass2Samples) {
    console.log(
      `  ↳ "${(s.later ?? "").slice(0, 70)}" ← "${(s.earlier ?? "").slice(0, 70)}" ` +
        `(J=${s.jaccard.toFixed(2)}): ${s.reasoning}`
    );
  }
}

// ─── Evergreen side-effect ───────────────────────────────────────────────
// Per-original: count queued reposts, track earliest & latest repost dates.
const originalStats = new Map(); // id -> { count, earliest, latest }
const itemsById = new Map(items.map((it) => [it.id, it]));
for (const [laterId, { repostedFromItemId }] of repostUpdates) {
  const laterItem = itemsById.get(laterId);
  const d = laterItem?.published_date ?? null;
  let s = originalStats.get(repostedFromItemId);
  if (!s) originalStats.set(repostedFromItemId, (s = { count: 0, earliest: d, latest: d }));
  s.count++;
  if (d) {
    if (!s.earliest || d < s.earliest) s.earliest = d;
    if (!s.latest || d > s.latest) s.latest = d;
  }
}

let evergreenUpdates = 0;
const evergreenPayloads = new Map(); // originalId -> { reasoning }
for (const [origId, stats] of originalStats) {
  if (stats.count === 0) continue;
  const orig = itemsById.get(origId);
  if (!orig) continue;
  if (orig.is_evergreen === true) continue; // already set; don't stomp
  const dateRange =
    stats.earliest && stats.latest
      ? stats.earliest === stats.latest
        ? ` on ${stats.earliest}`
        : ` between ${stats.earliest} and ${stats.latest}`
      : "";
  evergreenPayloads.set(origId, {
    reasoning: `Proven evergreen: reposted ${stats.count} time${stats.count === 1 ? "" : "s"}${dateRange}.`,
  });
  evergreenUpdates++;
}

console.log(
  `\nEvergreen side-effect: ${evergreenUpdates} originals would be flipped to isEvergreen=true.`
);

// ─── Summary by platform ─────────────────────────────────────────────────
const platformCounts = {};
for (const [id] of repostUpdates) {
  const it = itemsById.get(id);
  for (const p of it?._platforms ?? []) {
    platformCounts[p] = (platformCounts[p] || 0) + 1;
  }
}
console.log("\nReclassified reposts by platform:");
for (const [p, c] of Object.entries(platformCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(30)} ${c}`);
}
console.log(
  `\nTotals — reposts: ${repostUpdates.size} (pass1=${pass1Count}, pass2=${pass2Count}), ` +
    `evergreen flips: ${evergreenUpdates}`
);

// ─── Apply ───────────────────────────────────────────────────────────────
if (dryRun) {
  console.log("\nDry run — no writes. Re-run with --apply to commit.");
  await sql.end();
  process.exit(0);
}

console.log("\nApplying writes…");
await sql.begin(async (tx) => {
  for (const [laterId, { repostedFromItemId }] of repostUpdates) {
    await tx`
      UPDATE production_items
      SET source_type = 'repost',
          reposted_from_item_id = ${repostedFromItemId},
          updated_at = NOW()
      WHERE id = ${laterId}
        AND source_type = 'original'
    `;
  }
  for (const [origId, { reasoning }] of evergreenPayloads) {
    await tx`
      UPDATE production_items
      SET is_evergreen = true,
          evergreen_reasoning = ${reasoning},
          evergreen_evaluated_at = NOW(),
          updated_at = NOW()
      WHERE id = ${origId}
        AND source_type = 'original'
        AND (is_evergreen IS NULL OR is_evergreen = false)
    `;
  }
});

console.log(
  `Applied: ${repostUpdates.size} reposts linked, ${evergreenUpdates} originals stamped evergreen.`
);
await sql.end();
