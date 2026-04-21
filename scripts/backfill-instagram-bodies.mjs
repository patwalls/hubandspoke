#!/usr/bin/env node
/**
 * One-time backfill: fetch each Instagram post's caption from Scrape Creators
 * and write it into production_items.content_body for rows where we have an
 * IG URL but no body yet.
 *
 * Default cost: 1 SC credit per row (~$0.002).
 * With --with-media: 10 SC credits per row (~$0.02) — returns a permanent
 * ScrapeCreators-hosted URL to the primary media file (video/image) which
 * gets written into content_media_url.
 *
 * Usage:
 *   node scripts/backfill-instagram-bodies.mjs                      # dry-run
 *   node scripts/backfill-instagram-bodies.mjs --apply              # captions only
 *   node scripts/backfill-instagram-bodies.mjs --apply --with-media # + archive media
 *   node scripts/backfill-instagram-bodies.mjs --apply --limit=5    # bounded
 *
 *   heroku run --app=hubandspoke "node scripts/backfill-instagram-bodies.mjs --apply"
 *
 * Idempotent — skips rows that already have content_body set (unless
 * --with-media, which also requires content_media_url to be NULL).
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
const WITH_MEDIA = process.argv.includes("--with-media");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : null;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}
if (!process.env.SCRAPE_CREATORS_API_KEY) {
  console.error("ERROR: SCRAPE_CREATORS_API_KEY missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

const SC_BASE = "https://api.scrapecreators.com";
const SC_HEADERS = { "x-api-key": process.env.SCRAPE_CREATORS_API_KEY };
const CREDITS_PER_CALL = WITH_MEDIA ? 10 : 1;

async function fetchIgPost(postUrl) {
  const q = new URLSearchParams({ url: postUrl });
  if (WITH_MEDIA) q.set("download_media", "true");
  const res = await fetch(
    `${SC_BASE}/v1/instagram/post?${q.toString()}`,
    { headers: SC_HEADERS }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SC ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractCaption(media) {
  return media?.edge_media_to_caption?.edges?.[0]?.node?.text || null;
}

async function main() {
  const mode = DRY_RUN ? "[DRY RUN] " : "";
  const mediaNote = WITH_MEDIA ? " +media" : "";
  console.log(
    `${mode}Backfilling Instagram captions${mediaNote}${LIMIT ? ` (limit=${LIMIT})` : ""}\n`
  );

  // Select rows missing content_body; if --with-media, also allow rows that
  // have a body but still lack an archived media URL.
  const rows = WITH_MEDIA
    ? await sql`
        SELECT id, published_link
        FROM production_items
        WHERE (content_body IS NULL OR content_media_url IS NULL)
          AND published_link ~ 'instagram\.com/(p|reel|reels|tv)/[A-Za-z0-9_-]+'
        ORDER BY published_date DESC NULLS LAST
        ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}
      `
    : await sql`
        SELECT id, published_link
        FROM production_items
        WHERE content_body IS NULL
          AND published_link ~ 'instagram\.com/(p|reel|reels|tv)/[A-Za-z0-9_-]+'
        ORDER BY published_date DESC NULLS LAST
        ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}
      `;

  console.log(
    `Found ${rows.length} IG rows needing ${WITH_MEDIA ? "caption and/or media" : "caption"}\n`
  );

  let filled = 0;
  let miss = 0;
  let errors = 0;

  for (const r of rows) {
    try {
      if (DRY_RUN) {
        console.log(`  [dry] would fetch ${r.published_link}`);
        continue;
      }
      const data = await fetchIgPost(r.published_link);
      const media = data?.data?.xdt_shortcode_media;
      if (!media) {
        console.log(`  [miss] ${r.published_link} — no media`);
        miss++;
        continue;
      }
      const caption = extractCaption(media);
      const archivedMedia = WITH_MEDIA
        ? data?.download_media_urls?.[0] ?? null
        : null;
      const ephemeral = media.video_url ?? media.display_url ?? null;
      const contentMediaUrl = archivedMedia ?? ephemeral;

      const updates = [];
      const values = [];
      if (caption) {
        updates.push(`content_body = $${updates.length + 1}`);
        values.push(caption);
        updates.push(`content_body_fetched_at = now()`);
        updates.push(`content_body_source = 'scrape_creators'`);
      }
      if (contentMediaUrl) {
        updates.push(`content_media_url = $${updates.length + 1}`);
        values.push(contentMediaUrl);
      }
      if (updates.length === 0) {
        console.log(`  [miss] ${r.published_link} — nothing to write`);
        miss++;
        continue;
      }
      // Tag-literal friendly update
      if (caption && contentMediaUrl) {
        await sql`
          UPDATE production_items
          SET content_body = ${caption},
              content_body_fetched_at = now(),
              content_body_source = 'scrape_creators',
              content_media_url = ${contentMediaUrl},
              updated_at = now()
          WHERE id = ${r.id}
        `;
      } else if (caption) {
        await sql`
          UPDATE production_items
          SET content_body = ${caption},
              content_body_fetched_at = now(),
              content_body_source = 'scrape_creators',
              updated_at = now()
          WHERE id = ${r.id}
        `;
      } else if (contentMediaUrl) {
        await sql`
          UPDATE production_items
          SET content_media_url = ${contentMediaUrl},
              updated_at = now()
          WHERE id = ${r.id}
        `;
      }
      filled++;
      if (filled % 10 === 0) console.log(`  [${filled}] ${r.published_link}`);
    } catch (err) {
      errors++;
      console.error(`  [err] ${r.published_link}:`, err.message);
    }
  }

  const totalCredits = (filled + miss) * CREDITS_PER_CALL;
  console.log(
    `\n${mode}Done. filled=${filled} miss=${miss} errors=${errors} total=${rows.length} credits=${totalCredits}`
  );
  if (DRY_RUN && rows.length > 0) {
    console.log(
      `\nRe-run with --apply to persist. Estimated cost: ${rows.length * CREDITS_PER_CALL} SC credits.`
    );
  }
  await sql.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  sql.end();
  process.exit(1);
});
