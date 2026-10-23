/**
 * One-shot backfill: split the Futurepedia brand into a brand family —
 * Futurepedia (parent) + Skill Leap + Howfinity (children via
 * `brands.parent_brand_id`). Each child becomes a full brand with its own
 * accounts, formats, statuses and queue; the top nav groups them under one
 * pill.
 *
 * What moves:
 *   - accounts: by (platform, handle) — see ACCOUNT_MOVES.
 *   - formats: a format moves when every account it posts to (format_channels)
 *     now lives in the same child brand. Channel-less formats (the newsletter
 *     pilots — the drafter hard-codes "futurepedia") stay put.
 *   - production_items: follow their format's brand (format lookups are keyed
 *     on (brand, name), so an item must share its format's brand). Items with
 *     no format, or a format name that matches no Futurepedia format, follow
 *     their account's brand.
 *   - brand_logos: Skill Leap logos by label prefix.
 * New brands get a copy of Futurepedia's status palette and settings.
 *
 * Idempotent: re-running finds nothing left to move. Defaults to dry-run.
 *
 *   node --env-file=.env.local scripts/backfill-split-futurepedia-brands.mjs
 *   heroku run --app hubandspoke -- node scripts/backfill-split-futurepedia-brands.mjs --apply
 */
import postgres from "postgres";

const apply = process.argv.slice(2).includes("--apply");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const PARENT_SLUG = "futurepedia";

const CHILD_BRANDS = [
  { slug: "skill-leap", label: "Skill Leap", avatarFrom: ["youtube", "skillleapai"], color: "from-violet-500 to-purple-700" },
  { slug: "howfinity", label: "Howfinity", avatarFrom: ["youtube", "howfinity"], color: "from-orange-500 to-red-600" },
];

// [platform, lower(handle)] → child brand slug. Saj's personal accounts go
// with Skill Leap (Sam, 2026-10-23).
const ACCOUNT_MOVES = [
  ["youtube", "skillleapai", "skill-leap"],
  ["instagram", "skillleapai", "skill-leap"],
  ["linkedin", "skill-leap-ai", "skill-leap"],
  ["x", "saj_adib", "skill-leap"],
  ["linkedin", "sajadib", "skill-leap"],
  ["youtube", "howfinity", "howfinity"],
  ["tiktok", "howfinity", "howfinity"],
];

const LOGO_MOVES = [["skillleap%", "skill-leap"]];

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 2,
});

class DryRun extends Error {}

async function run(tx) {
  const [parent] = await tx`SELECT * FROM brands WHERE slug = ${PARENT_SLUG}`;
  if (!parent) throw new Error(`brand ${PARENT_SLUG} not found`);

  // ── Brands ────────────────────────────────────────────────────────────
  const brandIdBySlug = new Map([[PARENT_SLUG, parent.id]]);
  // The nav's family dropdown follows sort_order, so children sort right
  // after the parent in CHILD_BRANDS order (Futurepedia, Skill Leap,
  // Howfinity). Children never show top-level, so ties with other brands'
  // sort_order don't matter.
  for (const [i, child] of CHILD_BRANDS.entries()) {
    const sortOrder = parent.sort_order + i + 1;
    const [existing] = await tx`SELECT id FROM brands WHERE slug = ${child.slug}`;
    if (existing) {
      brandIdBySlug.set(child.slug, existing.id);
      await tx`UPDATE brands SET parent_brand_id = ${parent.id}, sort_order = ${sortOrder} WHERE id = ${existing.id}`;
      console.log(`brand ${child.slug}: exists`);
      continue;
    }
    const [avatarRow] = await tx`
      SELECT avatar_url FROM accounts
       WHERE platform = ${child.avatarFrom[0]} AND lower(handle) = ${child.avatarFrom[1]} AND avatar_url IS NOT NULL
       LIMIT 1`;
    const [created] = await tx`
      INSERT INTO brands (slug, label, avatar_url, color, weekly_goal, weekly_views_goal,
                          week_start_day, default_editor_user_id, cta_fallback_url,
                          sort_order, parent_brand_id)
      VALUES (${child.slug}, ${child.label}, ${avatarRow?.avatar_url ?? null}, ${child.color},
              ${parent.weekly_goal}, ${parent.weekly_views_goal}, ${parent.week_start_day},
              ${parent.default_editor_user_id}, ${parent.cta_fallback_url},
              ${sortOrder}, ${parent.id})
      RETURNING id`;
    brandIdBySlug.set(child.slug, created.id);
    const statuses = await tx`
      INSERT INTO brand_statuses (brand_id, name, color, position, is_pipeline_column, is_protected)
      SELECT ${created.id}, name, color, position, is_pipeline_column, is_protected
        FROM brand_statuses WHERE brand_id = ${parent.id}
      RETURNING name`;
    console.log(`brand ${child.slug}: created (+${statuses.length} statuses)`);
  }

  // ── Accounts ──────────────────────────────────────────────────────────
  const brandOfAccount = new Map(); // account id → slug after the move
  const accounts = await tx`SELECT id, platform, handle FROM accounts WHERE brand_id = ANY(${[...brandIdBySlug.values()]})`;
  for (const a of accounts) {
    const move = ACCOUNT_MOVES.find(([p, h]) => p === a.platform && h === a.handle.toLowerCase());
    const target = move ? move[2] : null;
    const currentSlug = [...brandIdBySlug].find(([, id]) => id === a.brand_id)?.[0];
    brandOfAccount.set(a.id, target ?? currentSlug ?? PARENT_SLUG);
  }
  for (const [platform, handle, slug] of ACCOUNT_MOVES) {
    const moved = await tx`
      UPDATE accounts SET brand_id = ${brandIdBySlug.get(slug)}, updated_at = now()
       WHERE brand_id = ${parent.id} AND platform = ${platform} AND lower(handle) = ${handle}
       RETURNING handle`;
    for (const m of moved) console.log(`account ${platform}/${m.handle} → ${slug}`);
  }

  // ── Formats ───────────────────────────────────────────────────────────
  const formats = await tx`
    SELECT f.id, f.name, array_remove(array_agg(fc.account_id), NULL) AS account_ids
      FROM formats f LEFT JOIN format_channels fc ON fc.format_id = f.id
     WHERE f.brand = ${PARENT_SLUG}
     GROUP BY f.id, f.name`;
  const formatTarget = new Map(); // lower(name) → slug
  for (const f of formats) {
    const targets = new Set(f.account_ids.map((id) => brandOfAccount.get(id) ?? PARENT_SLUG));
    const target = targets.size === 1 ? [...targets][0] : PARENT_SLUG;
    formatTarget.set(f.name.toLowerCase(), target);
    if (target === PARENT_SLUG) {
      console.log(`format "${f.name}": stays (${targets.size === 0 ? "no channels" : [...targets].join("+")})`);
      continue;
    }
    await tx`UPDATE formats SET brand = ${target}, updated_at = now() WHERE id = ${f.id}`;
    console.log(`format "${f.name}" → ${target}`);
  }

  // ── Production items ──────────────────────────────────────────────────
  const items = await tx`SELECT id, format, account_id FROM production_items WHERE brand = ${PARENT_SLUG}`;
  const itemMoves = new Map(); // slug → ids
  const why = new Map(); // "slug via format|account" → count
  for (const it of items) {
    const byFormat = it.format ? formatTarget.get(it.format.toLowerCase()) : undefined;
    const target = byFormat ?? (it.account_id ? brandOfAccount.get(it.account_id) : undefined) ?? PARENT_SLUG;
    if (target === PARENT_SLUG) continue;
    if (!itemMoves.has(target)) itemMoves.set(target, []);
    itemMoves.get(target).push(it.id);
    const key = `${target} via ${byFormat ? `format "${it.format}"` : "account"}`;
    why.set(key, (why.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...why].sort()) console.log(`items → ${key}: ${n}`);
  for (const [slug, ids] of itemMoves) {
    for (let i = 0; i < ids.length; i += 1000) {
      await tx`UPDATE production_items SET brand = ${slug} WHERE id = ANY(${ids.slice(i, i + 1000)}::uuid[])`;
    }
  }
  console.log(`items staying in ${PARENT_SLUG}: ${items.length - [...itemMoves.values()].reduce((n, ids) => n + ids.length, 0)}`);

  // ── Logos ─────────────────────────────────────────────────────────────
  for (const [pattern, slug] of LOGO_MOVES) {
    const moved = await tx`UPDATE brand_logos SET brand = ${slug} WHERE brand = ${PARENT_SLUG} AND lower(label) LIKE ${pattern} RETURNING label`;
    for (const m of moved) console.log(`logo "${m.label}" → ${slug}`);
  }

  // ── User / invite brand associations ──────────────────────────────────
  // Informational (no access gating), but "my brands" views read it — anyone
  // on Futurepedia gets the whole family.
  const childIds = CHILD_BRANDS.map((c) => brandIdBySlug.get(c.slug));
  for (const table of ["users", "invites"]) {
    const rows = await tx`SELECT id, brand_ids FROM ${tx(table)} WHERE brand_ids ? ${parent.id}`;
    let touched = 0;
    for (const r of rows) {
      const next = [...new Set([...r.brand_ids, ...childIds])];
      if (next.length === r.brand_ids.length) continue;
      await tx`UPDATE ${tx(table)} SET brand_ids = ${tx.json(next)} WHERE id = ${r.id}`;
      touched++;
    }
    console.log(`${table}: added family brands to ${touched} of ${rows.length} Futurepedia rows`);
  }

  if (!apply) throw new DryRun();
}

try {
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  await sql.begin(run);
  console.log("Applied.");
} catch (err) {
  if (err instanceof DryRun) console.log("Dry run — rolled back. Pass --apply to commit.");
  else {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
