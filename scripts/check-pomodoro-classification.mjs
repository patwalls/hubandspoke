/**
 * Read-only spot-check: when the dry-run script applies, what does each item
 * in the pomodoro / "still convinced" cluster get set to?
 *
 * Re-runs the same logic as backfill-repost-classification.mjs (Pass 1a + 1b
 * + Pass 2 cache lookups) so we can verify each item's planned
 * sourceType + repostedFromItemId without touching the DB.
 */
import postgres from "postgres";
import { readFileSync, existsSync } from "node:fs";

const sql = postgres(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === "off" ? false : "require", prepare: false, max: 2 });

const STOPWORDS = new Set(["a","an","the","and","or","but","of","for","to","in","on","at","by","with","from","is","was","are","were","i","my","me","you","your","this","that","it","its","as","be","have","has","had"]);
function normalizeTitle(t) {
  if (!t) return "";
  return t.toLowerCase().replace(/[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{2600}-\u{27BF}]/gu, "").replace(/[\s ]+/g, " ").replace(/[.,!?;:"'`~\-–—()[\]{}]+$/g, "").trim();
}
function tokenize(t) {
  const norm = (t ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!norm) return new Set();
  return new Set(norm.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
function normalizeBody(body) {
  if (!body) return "";
  return body.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[@#][\w.-]+/g, " ").replace(/[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{2600}-\u{27BF}]/gu, "").replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
}
function cmpEarliest(a, b) {
  const ad = a.published_date instanceof Date ? a.published_date.toISOString().slice(0,10) : String(a.published_date).slice(0,10);
  const bd = b.published_date instanceof Date ? b.published_date.toISOString().slice(0,10) : String(b.published_date).slice(0,10);
  if (ad !== bd) return ad < bd ? -1 : 1;
  const ac = a.created_at?.getTime?.() ?? Infinity;
  const bc = b.created_at?.getTime?.() ?? Infinity;
  return ac - bc;
}
function pairKey(a, b) { return a < b ? `${a}::${b}` : `${b}::${a}`; }

const items = await sql`
  SELECT pi.id, pi.title, pi.content_body, pi.platform AS legacy_platform,
         pi.brand, pi.published_date, pi.created_at,
         pi.source_type, pi.reposted_from_item_id,
         a.platform AS account_platform, a.handle AS account_handle
  FROM production_items pi LEFT JOIN accounts a ON a.id = pi.account_id
  WHERE pi.source_type = 'original' AND pi.status = 'Published' AND pi.published_date IS NOT NULL
    AND pi.title IS NOT NULL AND pi.title <> '' AND pi.title NOT ILIKE '%(Backfilled)%' AND pi.deleted_at IS NULL
`;

for (const it of items) {
  it._norm = normalizeTitle(it.title);
  it._tokens = tokenize(it.title);
  it._normBody = normalizeBody(it.content_body);
  if (it.account_platform) it._platforms = [String(it.account_platform).toLowerCase()];
  else if (Array.isArray(it.legacy_platform) && it.legacy_platform.length > 0) {
    it._platforms = it.legacy_platform.map((p) => String(p).toLowerCase().replace(/\s*\(.+\)\s*$/, "").trim());
  } else it._platforms = [];
}

const repostUpdates = new Map();

// Pass 1a
const titleGroups = new Map();
for (const it of items) {
  if (!it._norm || it._platforms.length === 0) continue;
  const key = `${it.brand}::${it._norm}`;
  if (!titleGroups.has(key)) titleGroups.set(key, []);
  titleGroups.get(key).push(it);
}
for (const group of titleGroups.values()) {
  if (group.length < 2) continue;
  group.sort(cmpEarliest);
  const earliest = group[0];
  const earliestPlatforms = new Set(earliest._platforms);
  for (let i = 1; i < group.length; i++) {
    const cand = group[i];
    if (cand._platforms.some((p) => earliestPlatforms.has(p))) {
      if (!repostUpdates.has(cand.id)) repostUpdates.set(cand.id, { repostedFromItemId: earliest.id, via: "pass1a" });
    }
  }
}

// Pass 1b
const bodyGroups = new Map();
for (const it of items) {
  if (!it._normBody || it._normBody.length < 20 || it._platforms.length === 0) continue;
  const key = `${it.brand}::${it._normBody}`;
  if (!bodyGroups.has(key)) bodyGroups.set(key, []);
  bodyGroups.get(key).push(it);
}
for (const group of bodyGroups.values()) {
  if (group.length < 2) continue;
  group.sort(cmpEarliest);
  const earliest = group[0];
  const earliestPlatforms = new Set(earliest._platforms);
  for (let i = 1; i < group.length; i++) {
    const cand = group[i];
    if (cand._platforms.some((p) => earliestPlatforms.has(p))) {
      if (repostUpdates.has(cand.id)) continue;
      let target = earliest.id;
      const ex = repostUpdates.get(earliest.id);
      if (ex) target = ex.repostedFromItemId;
      repostUpdates.set(cand.id, { repostedFromItemId: target, via: "pass1b" });
    }
  }
}

// Pass 2 — apply cached LLM verdicts only
const cachePath = ".repost-llm-cache.json";
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
const unmatched = items.filter((it) => !repostUpdates.has(it.id));
const buckets = new Map();
for (const it of unmatched) {
  if (it._tokens.size === 0) continue;
  for (const p of it._platforms) {
    const key = `${it.brand}::${p}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
}
const candidates = [];
const seenPairs = new Set();
for (const [bucketKey, bucket] of buckets) {
  if (bucket.length < 2) continue;
  for (let i = 0; i < bucket.length; i++) {
    const a = bucket[i];
    for (let j = i + 1; j < bucket.length; j++) {
      const b = bucket[j];
      if (a._norm && a._norm === b._norm) continue;
      const la = a.title.length, lb = b.title.length;
      const ratio = la > lb ? la / lb : lb / la;
      if (ratio > 3.0) continue;
      const jac = jaccard(a._tokens, b._tokens);
      if (jac < 0.5) continue;
      const key = pairKey(a.id, b.id);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      candidates.push({ a, b, jaccard: jac });
    }
  }
}
candidates.sort((x, y) => y.jaccard - x.jaccard);
for (const { a, b } of candidates.slice(0, 4000)) {
  const key = pairKey(a.id, b.id);
  const v = cache[key];
  if (!v?.same) continue;
  const earlier = cmpEarliest(a, b) <= 0 ? a : b;
  const later = earlier === a ? b : a;
  if (repostUpdates.has(later.id)) continue;
  let target = earlier.id;
  const ex = repostUpdates.get(earlier.id);
  if (ex) target = ex.repostedFromItemId;
  repostUpdates.set(later.id, { repostedFromItemId: target, via: "pass2-cached" });
}

// Pomodoro report
const pomodoroItems = items.filter((it) => it.title?.toLowerCase().includes("still convinced") || it.title?.toLowerCase().includes("pomodoro"));
const itemsById = new Map(items.map((i) => [i.id, i]));

console.log(`\nPomodoro cluster — ${pomodoroItems.length} items, dry-run preview:`);
console.log("(items NOT in this loaded set are either not 'original' source_type or not 'Published' status — they're already correctly classified or not eligible)\n");

pomodoroItems.sort((a, b) => cmpEarliest(a, b));
for (const it of pomodoroItems) {
  const upd = repostUpdates.get(it.id);
  const date = it.published_date?.toISOString?.().slice(0,10) ?? "?";
  if (upd) {
    const parent = itemsById.get(upd.repostedFromItemId);
    console.log(
      `  ${it.id.slice(0,8)} ${date} [${it.account_platform}] @${it.account_handle} :: ` +
      `original → repost via ${upd.via}, parent=${parent?.id.slice(0,8)} (@${parent?.account_handle} ${parent?.published_date?.toISOString?.().slice(0,10)})`
    );
  } else {
    console.log(
      `  ${it.id.slice(0,8)} ${date} [${it.account_platform}] @${it.account_handle} :: stays original (canonical)`
    );
  }
}

await sql.end();
