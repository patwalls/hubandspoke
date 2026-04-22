#!/usr/bin/env node
/**
 * Selective backfill driver for the enrichment sweep. Loops the
 * /api/cron/enrichment-sweep endpoint until either every eligible item has
 * been processed or the requested cap is hit.
 *
 * The sweep itself runs hourly via cron — this script is for catch-up after
 * deploys (when many items are unenriched) or for re-running a specific
 * platform after a bug fix.
 *
 * Usage:
 *   BASE_URL=https://hubandspoke.example.com \
 *   CRON_SECRET=... \
 *     node scripts/backfill-enrichment.mjs --platform=instagram --limit=200
 *
 *   # Force re-enrichment of already-enriched items (burns credits — use
 *   # only when an enricher was bugged and needs to overwrite stale data):
 *   node scripts/backfill-enrichment.mjs --platform=tiktok --force --limit=50
 *
 *   # Default: every supported platform, batches of 50 until exhausted.
 *   # Cheap path: ~2 SC credits per IG item (caption + poster + transcript +
 *   # author). The 10-credit raw video archive is OFF by default:
 *   node scripts/backfill-enrichment.mjs
 *
 *   # Add --with-media to also archive the raw IG video file to S3 (10 SC
 *   # credits per IG item, ~12 total). No-op for non-IG platforms.
 *   node scripts/backfill-enrichment.mjs --platform=instagram --with-media
 *
 * Heroku:
 *   heroku run --app=hubandspoke -- \
 *     bash -lc "BASE_URL=https://hubandspoke.herokuapp.com \
 *               node scripts/backfill-enrichment.mjs --platform=instagram"
 *
 * Idempotent: each tick re-queries items missing enrichment; once everything
 * is enriched the loop exits with `enriched=0`.
 */

const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_SECRET;
if (!BASE_URL) {
  console.error("ERROR: BASE_URL env var required (e.g. http://localhost:3000)");
  process.exit(1);
}
if (!CRON_SECRET) {
  console.error("ERROR: CRON_SECRET env var required");
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return true;
}

const PLATFORM = flag("platform");
const FORCE = flag("force") === true || flag("force") === "true";
const WITH_MEDIA =
  flag("with-media") === true || flag("with-media") === "true";
const BATCH_SIZE = parseInt(flag("batch") || "50", 10);
const MAX_BATCHES = parseInt(flag("max-batches") || "100", 10);
const TOTAL_CAP = flag("limit") ? parseInt(flag("limit"), 10) : Infinity;

const VALID_PLATFORMS = [
  "youtube",
  "youtube_community",
  "instagram",
  "twitter",
  "threads",
  "linkedin",
  "tiktok",
];
if (PLATFORM && !VALID_PLATFORMS.includes(PLATFORM)) {
  console.error(`ERROR: --platform must be one of: ${VALID_PLATFORMS.join(", ")}`);
  process.exit(1);
}

console.log(`→ ${BASE_URL}`);
console.log(
  `   platform=${PLATFORM ?? "all"} force=${FORCE} with-media=${WITH_MEDIA} ` +
    `batch=${BATCH_SIZE} max-batches=${MAX_BATCHES} ` +
    `cap=${Number.isFinite(TOTAL_CAP) ? TOTAL_CAP : "∞"}`
);

let totalEnriched = 0;
let totalFailed = 0;
let totalCredits = 0;

for (let i = 1; i <= MAX_BATCHES; i++) {
  if (totalEnriched >= TOTAL_CAP) {
    console.log(`Hit total cap (${TOTAL_CAP}) — stopping.`);
    break;
  }

  const remaining = TOTAL_CAP - totalEnriched;
  const tickLimit = Math.min(BATCH_SIZE, remaining);
  const params = new URLSearchParams({ limit: String(tickLimit) });
  if (PLATFORM) params.set("platform", PLATFORM);
  if (FORCE) params.set("force", "true");
  if (WITH_MEDIA) params.set("withMedia", "true");

  const url = `${BASE_URL}/api/cron/enrichment-sweep?${params.toString()}`;
  process.stdout.write(`Batch ${i}: `);
  const start = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
  } catch (err) {
    console.log(`fetch error: ${err.message}`);
    break;
  }
  if (!res.ok) {
    const body = await res.text();
    console.log(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    break;
  }
  const json = await res.json();
  const s = json.summary;
  const sec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `scanned=${s.scanned} enriched=${s.enriched} failed=${s.failed} ` +
      `skipped=${s.skipped} credits=${s.creditsSpent} (${sec}s)`
  );
  if (s.errors?.length) {
    for (const e of s.errors.slice(0, 3)) {
      console.log(`   err: ${e.itemId}: ${e.message?.slice(0, 120)}`);
    }
  }
  totalEnriched += s.enriched;
  totalFailed += s.failed;
  totalCredits += s.creditsSpent;

  // Empty batch → nothing left to enrich.
  if (s.scanned === 0 || (s.enriched === 0 && s.failed === 0 && s.skipped === s.scanned)) {
    console.log("No more eligible items — done.");
    break;
  }
}

console.log("");
console.log(
  `Total: enriched=${totalEnriched} failed=${totalFailed} credits=${totalCredits}`
);
