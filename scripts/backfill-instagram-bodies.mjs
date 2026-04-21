#!/usr/bin/env node
/**
 * One-time backfill: fetch each Instagram post's caption from Scrape Creators
 * and write it into production_items.content_body for rows where we have an
 * IG URL but no body yet.
 *
 * Default cost: 1 SC credit per row (~$0.002).
 * With --with-media: 10 SC credits per row (~$0.02). Downloads the primary
 * media file from ScrapeCreators' permanent URL and uploads it to our S3
 * bucket. Writes production_items.media_s3_bucket/key/etc. so the archive is
 * durable and owned by us. Caption still gets written even if S3 upload fails.
 *
 * Usage:
 *   node scripts/backfill-instagram-bodies.mjs                      # dry-run
 *   node scripts/backfill-instagram-bodies.mjs --apply              # captions only
 *   node scripts/backfill-instagram-bodies.mjs --apply --with-media # + archive to S3
 *   node scripts/backfill-instagram-bodies.mjs --apply --limit=5    # bounded
 *
 *   heroku run --app=hubandspoke "node scripts/backfill-instagram-bodies.mjs --apply"
 *
 * Idempotent: skips rows that already have content_body set for
 * captions-only; for --with-media also skips rows that already have
 * media_s3_key set.
 */
import postgres from "postgres";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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
if (WITH_MEDIA && !process.env.HUBANDSPOKE_S3_BUCKET) {
  console.error("ERROR: HUBANDSPOKE_S3_BUCKET missing (required for --with-media)");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

const SC_BASE = "https://api.scrapecreators.com";
const SC_HEADERS = { "x-api-key": process.env.SCRAPE_CREATORS_API_KEY };
const CREDITS_PER_CALL = WITH_MEDIA ? 10 : 1;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

const s3 = WITH_MEDIA
  ? new S3Client({ region: process.env.AWS_REGION || "us-east-1" })
  : null;
const S3_BUCKET = process.env.HUBANDSPOKE_S3_BUCKET;
const S3_PREFIX = (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads").replace(/\/+$/, "");

function buildS3Key(itemId, fileName) {
  const safe =
    fileName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "file";
  return `${S3_PREFIX}/${itemId}/${randomUUID()}-${safe}`;
}

function shortcodeFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(
      /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/
    );
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function contentTypeFromUrl(url) {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

function extFromContentType(ct) {
  if (ct.startsWith("video/mp4")) return "mp4";
  if (ct === "video/quicktime") return "mov";
  if (ct === "image/png") return "png";
  if (ct === "image/webp") return "webp";
  return "jpg";
}

async function fetchIgPost(postUrl) {
  const q = new URLSearchParams({ url: postUrl });
  if (WITH_MEDIA) q.set("download_media", "true");
  const res = await fetch(`${SC_BASE}/v1/instagram/post?${q.toString()}`, {
    headers: SC_HEADERS,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SC ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractCaption(media) {
  return media?.edge_media_to_caption?.edges?.[0]?.node?.text || null;
}

async function archiveToS3(itemId, remoteUrl, igUrl) {
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const headerLen = Number(res.headers.get("content-length") ?? 0);
  if (headerLen && headerLen > MAX_MEDIA_BYTES) {
    throw new Error(`media size ${headerLen} exceeds ${MAX_MEDIA_BYTES}`);
  }
  const arr = await res.arrayBuffer();
  if (arr.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(`media size ${arr.byteLength} exceeds ${MAX_MEDIA_BYTES}`);
  }
  const contentType = res.headers.get("content-type") ?? contentTypeFromUrl(remoteUrl);
  const ext = extFromContentType(contentType);
  const shortcode = shortcodeFromUrl(igUrl) ?? "media";
  const fileName = `${shortcode}.${ext}`;
  const key = buildS3Key(itemId, fileName);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: Buffer.from(arr),
      ContentType: contentType,
    })
  );
  return { key, size: arr.byteLength, contentType };
}

async function main() {
  const mode = DRY_RUN ? "[DRY RUN] " : "";
  const mediaNote = WITH_MEDIA ? " + archive to S3" : "";
  console.log(
    `${mode}Backfilling Instagram captions${mediaNote}${LIMIT ? ` (limit=${LIMIT})` : ""}\n`
  );

  // For captions-only: rows where content_body IS NULL.
  // For --with-media: rows where content_body IS NULL OR media_s3_key IS NULL
  // (i.e. either the caption or the S3 archive is still missing).
  const rows = WITH_MEDIA
    ? await sql`
        SELECT id, published_link, content_body, media_s3_key
        FROM production_items
        WHERE (content_body IS NULL OR media_s3_key IS NULL)
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
    `Found ${rows.length} IG rows needing ${WITH_MEDIA ? "caption and/or archived media" : "caption"}\n`
  );

  let filled = 0;
  let miss = 0;
  let partial = 0;
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
      const ephemeral = media.video_url ?? media.display_url ?? null;

      // Archive to S3 if requested and not already archived.
      let archived = null;
      let archiveError = null;
      if (WITH_MEDIA && !r.media_s3_key) {
        const scHosted = data?.download_media_urls?.[0]?.cdn_url ?? null;
        if (scHosted) {
          try {
            archived = await archiveToS3(r.id, scHosted, r.published_link);
          } catch (err) {
            archiveError = err.message;
          }
        }
      }

      // Assemble the UPDATE. We always include updated_at.
      if (caption && archived) {
        await sql`
          UPDATE production_items
          SET content_body = ${caption},
              content_body_fetched_at = now(),
              content_body_source = 'scrape_creators',
              media_s3_bucket = ${S3_BUCKET},
              media_s3_key = ${archived.key},
              media_s3_uploaded_at = now(),
              media_size_bytes = ${archived.size},
              media_content_type = ${archived.contentType},
              content_media_url = NULL,
              updated_at = now()
          WHERE id = ${r.id}
        `;
      } else if (caption && WITH_MEDIA && !archived && ephemeral) {
        // Caption OK, S3 archive failed — fall back to ephemeral URL so we
        // still have a breadcrumb.
        await sql`
          UPDATE production_items
          SET content_body = ${caption},
              content_body_fetched_at = now(),
              content_body_source = 'scrape_creators',
              content_media_url = ${ephemeral},
              updated_at = now()
          WHERE id = ${r.id}
        `;
        partial++;
      } else if (caption) {
        await sql`
          UPDATE production_items
          SET content_body = ${caption},
              content_body_fetched_at = now(),
              content_body_source = 'scrape_creators',
              updated_at = now()
          WHERE id = ${r.id}
        `;
      } else if (archived) {
        await sql`
          UPDATE production_items
          SET media_s3_bucket = ${S3_BUCKET},
              media_s3_key = ${archived.key},
              media_s3_uploaded_at = now(),
              media_size_bytes = ${archived.size},
              media_content_type = ${archived.contentType},
              content_media_url = NULL,
              updated_at = now()
          WHERE id = ${r.id}
        `;
      } else if (ephemeral) {
        await sql`
          UPDATE production_items
          SET content_media_url = ${ephemeral}, updated_at = now()
          WHERE id = ${r.id}
        `;
      } else {
        console.log(`  [miss] ${r.published_link} — nothing to write`);
        miss++;
        continue;
      }

      filled++;
      if (archiveError) {
        console.error(`  [partial] ${r.published_link} — s3: ${archiveError}`);
      }
      if (filled % 10 === 0) console.log(`  [${filled}] ${r.published_link}`);
    } catch (err) {
      errors++;
      console.error(`  [err] ${r.published_link}:`, err.message);
    }
  }

  const totalCredits = (filled + miss) * CREDITS_PER_CALL;
  console.log(
    `\n${mode}Done. filled=${filled} partial=${partial} miss=${miss} errors=${errors} total=${rows.length} credits=${totalCredits}`
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
