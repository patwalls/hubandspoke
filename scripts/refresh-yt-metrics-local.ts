// Bulk-refresh YouTube view/like/comment counts for production_items where
// Scrape Creators has been failing to fetch metrics. Runs locally so it
// can use --cookies-from-browser=chrome — YouTube's anti-bot lets browser-
// cookie traffic through while it 404s SC's anonymous datacenter calls.
//
// What it does:
//   - Query prod for candidates (default: views IS NULL on SS yt-long in
//     the last year, with a youtube_url)
//   - For each: shell out to `yt-dlp --dump-json --skip-download` with
//     browser cookies, parse JSON for view_count / like_count / comment_count
//   - UPDATE production_items.{views, likes, comments,
//     last_performance_sync_at, last_performance_sync_error}
//
// What it does NOT do:
//   - No S3 upload, no media archive, no Whisper enqueue
//   - No Scrape Creators credit cost
//
// Usage:
//   PROD_DB_URL=$(heroku config:get DATABASE_URL --app hubandspoke) \
//     npx tsx scripts/refresh-yt-metrics-local.ts --brands=starter-story --since=2025-05-19 --post-types=youtube_long
//
// Flags:
//   --brands=a,b       comma-separated brand list (required unless --ids)
//   --since=YYYY-MM-DD only items with published_date >= this (required unless --ids)
//   --limit=N          cap candidates (default: 500)
//   --post-types=a,b   restrict to specific post types (e.g. youtube_long)
//   --ids=uuid1,uuid2  explicit IDs (overrides filter query)
//   --only-failed      default true. Restricts to rows whose
//                      last_performance_sync_error matches a "not_found"
//                      pattern (the SC-blocked-by-YT bucket).
//                      Pass --only-failed=false to refresh every missing-
//                      views row regardless of why.
//   --cookies-from-browser=chrome  default. `none` disables cookies.
//
// Exit code 0 on full success, 2 if any item failed (including deleted
// YouTube videos that yt-dlp can't resolve either).

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : undefined;
}

const BRANDS = (arg("brands") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SINCE = arg("since");
const LIMIT = Number(arg("limit") ?? "500");
const POST_TYPES = (arg("post-types") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ID_LIST = (arg("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_FAILED_ARG = arg("only-failed");
const ONLY_FAILED = ONLY_FAILED_ARG === undefined ? true : ONLY_FAILED_ARG !== "false";
const COOKIES_FROM_BROWSER = (arg("cookies-from-browser") ?? "chrome").trim();

if (ID_LIST.length === 0 && (!BRANDS.length || !SINCE)) {
  console.error("Usage: --brands=a,b --since=YYYY-MM-DD [--limit=N] [--post-types=youtube_long] [--only-failed=true|false] | --ids=uuid1,uuid2");
  process.exit(1);
}

const PROD_DB_URL = process.env.PROD_DB_URL;
if (!PROD_DB_URL) {
  console.error("PROD_DB_URL is required (heroku config:get DATABASE_URL --app hubandspoke)");
  process.exit(1);
}

const YT_DLP_PATH = resolve(process.cwd(), "node_modules/.yt-dlp-bin/yt-dlp");
// Metadata-only calls finish in 2-8 seconds on residential bandwidth. 30s
// caps a stalled request without leaving long-tail dead videos hanging.
const YT_DLP_TIMEOUT_MS = 30 * 1000;

interface YtMetadata {
  id: string;
  title?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  duration?: number;
  channel?: string;
}

function runYtDlpMetadata(url: string): Promise<YtMetadata> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "--dump-json",
      "--skip-download",
      "--no-warnings",
      "--no-progress",
      "--no-playlist",
      "--socket-timeout",
      "20",
    ];
    if (COOKIES_FROM_BROWSER && COOKIES_FROM_BROWSER !== "none") {
      args.push("--cookies-from-browser", COOKIES_FROM_BROWSER);
    }
    args.push(url);
    const proc = spawn(YT_DLP_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, signal);
      } catch {
        /* group already gone */
      }
    };
    const killTimer = setTimeout(() => {
      killedByTimeout = true;
      killTree("SIGKILL");
    }, YT_DLP_TIMEOUT_MS);
    proc.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      rejectPromise(new Error(`spawn: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (killedByTimeout) {
        rejectPromise(new Error(`timeout after ${YT_DLP_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (code !== 0) {
        const lastErr = stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 400);
        rejectPromise(new Error(`exited ${code}: ${lastErr}`));
        return;
      }
      try {
        // yt-dlp --dump-json prints one JSON object per line; for a single
        // URL with --no-playlist that's exactly one line.
        const line = stdout.trim().split("\n")[0];
        const obj = JSON.parse(line) as YtMetadata;
        resolvePromise(obj);
      } catch (err) {
        rejectPromise(new Error(`json parse: ${(err as Error).message}`));
      }
    });
  });
}

interface Candidate {
  id: string;
  youtube_url: string;
  title: string | null;
}

async function refreshOne(
  pool: pg.Pool,
  item: Candidate,
): Promise<{ ok: true; views: number | null; likes: number | null; comments: number | null } | { ok: false; err: string }> {
  try {
    const meta = await runYtDlpMetadata(item.youtube_url);
    const views = typeof meta.view_count === "number" ? meta.view_count : null;
    const likes = typeof meta.like_count === "number" ? meta.like_count : null;
    const comments = typeof meta.comment_count === "number" ? meta.comment_count : null;

    // Don't overwrite existing values with null — yt-dlp can return an
    // object with only some metric fields populated (likes are often
    // hidden by the channel). COALESCE keeps any prior real value.
    await pool.query(
      `UPDATE production_items
         SET views = COALESCE($2::bigint, views),
             likes = COALESCE($3::bigint, likes),
             comments = COALESCE($4::bigint, comments),
             last_performance_sync_at = NOW(),
             last_performance_sync_error = NULL
       WHERE id = $1`,
      [item.id, views, likes, comments],
    );
    return { ok: true, views, likes, comments };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stamp the error so the next run / dashboard reflects "we tried,
    // here's what happened" instead of leaving the prior SC 404 in place.
    await pool
      .query(
        `UPDATE production_items
           SET last_performance_sync_at = NOW(),
               last_performance_sync_error = $2
         WHERE id = $1`,
        [item.id, `yt-dlp-metadata: ${msg.slice(0, 400)}`],
      )
      .catch(() => {});
    return { ok: false, err: msg };
  }
}

async function main() {
  const pool = new pg.Pool({
    connectionString: PROD_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30 * 1000,
    idleTimeoutMillis: 30 * 60 * 1000,
  });
  pool.on("error", (err) => {
    console.warn(`[pool] backend conn error (will reconnect): ${err.message}`);
  });

  let items: Candidate[];
  if (ID_LIST.length > 0) {
    const r = await pool.query<Candidate>(
      `SELECT id, youtube_url, title
         FROM production_items
        WHERE id = ANY($1::uuid[])
          AND youtube_url IS NOT NULL`,
      [ID_LIST],
    );
    items = r.rows;
  } else {
    // Filter logic:
    //   - SS yt-long (or whatever brands+post-types passed) since the date
    //   - views IS NULL (would also let us re-run on rows with stale views,
    //     but for now we just fill in the blanks)
    //   - youtube_url IS NOT NULL (need a URL to feed yt-dlp)
    //   - if --only-failed (default): restrict to rows whose existing error
    //     matches the SC-not-found pattern. This is the bucket we're trying
    //     to recover. Pass --only-failed=false to attempt every blank-views
    //     row regardless of why (e.g. credit-exhaustion failures will also
    //     succeed via this path).
    const usePostTypeFilter = POST_TYPES.length > 0;
    const r = await pool.query<Candidate>(
      `SELECT id, youtube_url, title
         FROM production_items
        WHERE status = 'Published'
          AND youtube_url IS NOT NULL
          AND views IS NULL
          AND published_date >= $1::date
          AND brand = ANY($2::text[])
          ${usePostTypeFilter ? `AND post_type = ANY($4::text[])` : ``}
          ${ONLY_FAILED ? `AND last_performance_sync_error ILIKE '%not_found%'` : ``}
        ORDER BY published_date DESC NULLS LAST
        LIMIT $3`,
      usePostTypeFilter ? [SINCE, BRANDS, LIMIT, POST_TYPES] : [SINCE, BRANDS, LIMIT],
    );
    items = r.rows;
  }

  console.log(`Found ${items.length} candidates. Starting metadata refresh...`);
  const t0 = Date.now();
  let okCount = 0;
  let viewsFilled = 0;
  const failures: Array<{ id: string; title: string | null; err: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prefix = `[${i + 1}/${items.length}] ${item.id}`;
    process.stdout.write(`${prefix} ${(item.title ?? "").slice(0, 50)}... `);
    const start = Date.now();
    const res = await refreshOne(pool, item);
    const ms = Date.now() - start;
    if (res.ok) {
      okCount++;
      if (res.views !== null) viewsFilled++;
      const v = res.views !== null ? `${res.views.toLocaleString()} views` : "views=null";
      console.log(`✓ ${v} ${ms}ms`);
    } else {
      failures.push({ id: item.id, title: item.title, err: res.err });
      console.log(`✗ ${ms}ms — ${res.err.slice(0, 120)}`);
    }
  }

  console.log(`\n=== done ===`);
  console.log(
    `${okCount}/${items.length} succeeded, ${viewsFilled} got a real view count, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`,
  );
  if (failures.length) {
    console.log(`\nfailed:`);
    for (const f of failures) console.log(`  ${f.id}  "${(f.title ?? "").slice(0, 50)}" — ${f.err.slice(0, 160)}`);
  }
  await pool.end();
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
