#!/usr/bin/env node
/**
 * One-time backfill: rename legacy "Twitter" / "Twitter (Pat Walls)" platform
 * values to the new X-prefixed naming, directly in the H&S database.
 *
 * Rules:
 *   brand=starter-story:
 *     "Twitter" + publishedLink on thepatwalls/patrickwalls → "X (Pat Walls)"
 *     "Twitter" otherwise                                    → "X (Starter Story)"
 *     "Twitter (Pat Walls)"                                  → "X (Pat Walls)"
 *   brand=matg:
 *     "Twitter"                                              → "X"
 *
 * We do NOT touch Notion. notion-sync.ts applies the same remap at sync time
 * for crossposted YouTube pillars (the only path where Notion drives
 * `platform`), so future syncs won't revert this.
 *
 * Usage (after pushing to main and Heroku has deployed):
 *   heroku run --app=hubandspoke node scripts/backfill-twitter-pat-walls.mjs
 *   heroku run --app=hubandspoke node scripts/backfill-twitter-pat-walls.mjs --apply
 *
 * Local:
 *   node scripts/backfill-twitter-pat-walls.mjs              # dry-run (default)
 *   node scripts/backfill-twitter-pat-walls.mjs --apply      # persist changes
 *
 * Idempotent — re-running after --apply is a no-op.
 */
import postgres from "postgres";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "..", ".env.local") });

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

const PAT_WALLS_HANDLES = ["thepatwalls", "patrickwalls"];

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing from .env.local");
  process.exit(1);
}

const sslOpt = process.env.DATABASE_SSL === "off" ? false : "require";
console.log(`[debug] DATABASE_SSL=${JSON.stringify(process.env.DATABASE_SSL)} sslOpt=${JSON.stringify(sslOpt)}`);
const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: sslOpt,
});

function isPatWallsTweet(publishedLink) {
  if (!publishedLink) return false;
  try {
    const u = new URL(publishedLink);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "twitter.com" && host !== "x.com") return false;
    const handle = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return !!handle && PAT_WALLS_HANDLES.includes(handle);
  } catch {
    return false;
  }
}

function rename(channel, brand, publishedLink) {
  if (brand === "matg") {
    return channel === "Twitter" ? "X" : channel;
  }
  if (channel === "Twitter (Pat Walls)") return "X (Pat Walls)";
  if (channel === "Twitter") {
    return isPatWallsTweet(publishedLink) ? "X (Pat Walls)" : "X (Starter Story)";
  }
  return channel;
}

async function main() {
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Renaming Twitter/* → X/* in production_items\n`
  );

  const rows = await sql`
    SELECT id, title, brand, published_link, platform
    FROM production_items
    WHERE platform ?| array['Twitter', 'Twitter (Pat Walls)']
  `;

  console.log(`Found ${rows.length} rows with legacy Twitter names\n`);

  let changed = 0;
  let unchanged = 0;
  let errors = 0;

  for (const r of rows) {
    const current = Array.isArray(r.platform) ? r.platform : [];
    const next = current.map((c) => rename(c, r.brand, r.published_link));

    if (JSON.stringify(current) === JSON.stringify(next)) {
      unchanged++;
      continue;
    }

    changed++;
    console.log(
      `  ${DRY_RUN ? "WOULD" : "DID  "} [${r.brand}] "${(r.title || "").slice(0, 50)}"`
    );
    console.log(`    ${r.published_link || "(no link)"}`);
    console.log(`    ${current.join(", ")} → ${next.join(", ")}`);

    if (DRY_RUN) continue;

    try {
      await sql`
        UPDATE production_items
        SET platform = ${sql.json(next)}, updated_at = NOW()
        WHERE id = ${r.id}
      `;
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log(
    `\nDone. Changed: ${changed} | Unchanged: ${unchanged} | Errors: ${errors}`
  );
  if (DRY_RUN) console.log("\nRe-run with --apply to persist.");

  await sql.end();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
