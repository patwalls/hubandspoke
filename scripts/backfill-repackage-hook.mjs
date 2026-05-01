#!/usr/bin/env node
/**
 * One-shot data fix: for Instagram clips published in the
 * "Reel: Repackage Section w/ Hook" format (and the legacy
 * "Repackage section with hook"), set `overlay = trim(title)` and
 * `hook = trim(title)` with `hook_source = 'overlay'`.
 *
 * Why this exists:
 * For this format the editor types the on-video burn-in overlay text into
 * the `title` column. The unified hook dispatcher previously asked Haiku to
 * pick between title / caption / transcript and frequently picked the IG
 * caption (longer, more textually "hooky") over the short overlay sentence.
 * That left `hook` storing the post body, which is wrong — and that wrong
 * value gets fed back into the clip-idea LLM as exemplar data.
 *
 * The going-forward fix lives in `src/lib/services/hook-extract/dispatcher.ts`
 * (format-aware short-circuit) and in the production-items PUT route
 * (mirror title → overlay/hook on edit). This script cleans up the
 * historical rows.
 *
 * Scope:
 * - Only IG (instagram_reel / instagram_post) — cross-posts on X / TikTok /
 *   YouTube Shorts have auto-generated derivative titles like
 *   "Reel → X (...)" that would CORRUPT the hook if copied.
 * - Only source_type IN ('original', 'repost') — same reason.
 * - Skips hook_source IN ('manual', 'clip_idea') — those were set by a human
 *   or by clip-idea promotion and shouldn't be reprocessed.
 * - Skips rows whose title still starts with the literal format prefix
 *   "Reel: Repackage Section w/ Hook" — those are draft templates the editor
 *   never cleaned up. Reporting them at the end so they can be fixed
 *   manually or by the (orphaned) vision sweep.
 * - Idempotent: skips rows where overlay AND hook AND hook_source are
 *   already in the target state.
 *
 * Usage:
 *   node scripts/backfill-repackage-hook.mjs                # dry-run (default)
 *   node scripts/backfill-repackage-hook.mjs --apply        # actually update
 *   node scripts/backfill-repackage-hook.mjs --apply --limit=10
 *
 *   heroku run --app=hubandspoke "node scripts/backfill-repackage-hook.mjs --apply"
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
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : null;

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL missing");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  ssl: process.env.DATABASE_SSL === "off" ? false : "require",
});

const MAX_HOOK_CHARS = 240;

async function main() {
  console.log(`[backfill-repackage-hook] mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}${LIMIT ? ` limit=${LIMIT}` : ""}`);

  // Selection: matches the predicate in
  // src/lib/services/hook-extract/repackage.ts (format / post_type /
  // source_type) plus a "needs fixing" filter (overlay/hook differ from title
  // OR hook_source not in the target state).
  const candidates = await sql`
    SELECT
      id,
      title,
      hook,
      hook_source,
      overlay,
      post_type,
      source_type,
      format
    FROM production_items
    WHERE LOWER(format) IN (
            'reel: repackage section w/ hook',
            'repackage section with hook'
          )
      AND post_type IN ('instagram_reel', 'instagram_post')
      AND source_type IN ('original', 'repost')
      AND COALESCE(hook_source, '') NOT IN ('manual', 'clip_idea')
      AND title IS NOT NULL
      AND length(btrim(title)) > 0
    ORDER BY views DESC NULLS LAST
    ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}
  `;

  console.log(`[backfill-repackage-hook] found ${candidates.length} candidate rows`);

  // Titles starting with the format name itself are draft templates an
  // editor never replaced with real overlay text — copying them into hook
  // would store "Reel: Repackage Section w/ Hook (Author) actual text..."
  // and pollute the algorithm. Report at the end and skip.
  const MANGLED_PREFIX_RE = /^reel:\s*repackage\s+section\s+w\/\s*hook/i;

  let updated = 0;
  let skippedNoChange = 0;
  const skippedMangled = [];

  for (const row of candidates) {
    const trimmedTitle = row.title.trim();

    if (MANGLED_PREFIX_RE.test(trimmedTitle)) {
      skippedMangled.push(row);
      continue;
    }

    const newHook = trimmedTitle.slice(0, MAX_HOOK_CHARS);

    const alreadyCorrect =
      row.overlay === trimmedTitle &&
      row.hook === newHook &&
      row.hook_source === "overlay";
    if (alreadyCorrect) {
      skippedNoChange++;
      continue;
    }

    console.log("");
    console.log(`# ${row.id}  (${row.post_type} / ${row.source_type})`);
    console.log(`  was hook       (${row.hook_source ?? "null"}): ${truncate(row.hook)}`);
    console.log(`  was overlay:                                 ${truncate(row.overlay)}`);
    console.log(`  → hook         (overlay):                    ${truncate(newHook)}`);
    console.log(`  → overlay:                                   ${truncate(trimmedTitle)}`);

    if (APPLY) {
      await sql`
        UPDATE production_items
        SET overlay = ${trimmedTitle},
            hook = ${newHook},
            hook_source = 'overlay',
            hook_extractor = 'repackage-overlay-backfill:v1',
            hook_extracted_at = now(),
            updated_at = now()
        WHERE id = ${row.id}
      `;
      updated++;
    }
  }

  console.log("");
  console.log("─────────────────────────────────────────");
  console.log(`Candidates examined  : ${candidates.length}`);
  console.log(`Already correct      : ${skippedNoChange}`);
  console.log(`Skipped (draft title): ${skippedMangled.length}`);
  if (APPLY) {
    console.log(`Updated              : ${updated}`);
  } else {
    console.log(
      `Would update         : ${candidates.length - skippedNoChange - skippedMangled.length}`
    );
    console.log("(re-run with --apply to commit)");
  }

  if (skippedMangled.length > 0) {
    console.log("");
    console.log(`Skipped rows whose title is still a draft template (no real overlay text):`);
    for (const row of skippedMangled) {
      console.log(`  - ${row.id}  ${truncate(row.title)}`);
    }
    console.log(
      "These need an editor to replace the title, or the vision sweep to OCR the overlay from the cover image."
    );
  }

  // Sanity: report any remaining wrong rows so we can spot scope gaps.
  const remaining = await sql`
    SELECT COUNT(*)::int AS n
    FROM production_items
    WHERE LOWER(format) IN (
            'reel: repackage section w/ hook',
            'repackage section with hook'
          )
      AND post_type IN ('instagram_reel', 'instagram_post')
      AND source_type IN ('original', 'repost')
      AND status = 'Published'
      AND title IS NOT NULL
      AND COALESCE(hook_source, '') NOT IN ('manual', 'clip_idea')
      AND (
        overlay IS NULL
        OR overlay <> btrim(title)
        OR hook IS NULL
        OR hook <> LEFT(btrim(title), ${MAX_HOOK_CHARS})
        OR COALESCE(hook_source, '') <> 'overlay'
      )
  `;
  console.log(`Remaining published IG items needing fix: ${remaining[0].n}`);

  await sql.end();
}

function truncate(s) {
  if (s == null) return "(null)";
  const flat = String(s).replace(/\s+/g, " ");
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
