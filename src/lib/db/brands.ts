import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { asc, eq, sql } from "drizzle-orm";

// Row type inferred from the Drizzle table. Exported so callers can type
// props without importing the table definition directly.
export type Brand = typeof brands.$inferSelect;

// Brief shape used by nav tabs + brand pickers — just what we need to render
// a link/avatar without pulling the full row (excludes timestamps, goals,
// default assignee FKs).
export type BrandListEntry = Pick<
  Brand,
  "id" | "slug" | "label" | "avatarUrl" | "color" | "disabled"
>;

// Request-scoped cache so a single render doesn't re-query for every
// component that needs the brand list. Server components call getBrands()
// freely; Next's React cache() would also work but this is simpler.
let cached: { all: Brand[]; enabled: Brand[]; bySlug: Map<string, Brand> } | null = null;

// Preferred display order for the nav / pickers. Any slug not listed here
// falls to the end, sorted alphabetically. Cheaper than a sort_order column
// since brands are stable — edit this file when the desired order changes.
const BRAND_PRIORITY: Record<string, number> = {
  "starter-story": 0,
  "matg": 1,
};

async function load(): Promise<NonNullable<typeof cached>> {
  if (cached) return cached;
  const rows = await db.select().from(brands).orderBy(asc(brands.label));
  rows.sort((a, b) => {
    const pa = BRAND_PRIORITY[a.slug] ?? 99;
    const pb = BRAND_PRIORITY[b.slug] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.label.localeCompare(b.label);
  });
  const enabled = rows.filter((b) => !b.disabled);
  const bySlug = new Map(rows.map((b) => [b.slug, b]));
  cached = { all: rows, enabled, bySlug };
  return cached;
}

export async function getBrands(): Promise<Brand[]> {
  return (await load()).all;
}

export async function getEnabledBrands(): Promise<Brand[]> {
  return (await load()).enabled;
}

export async function getBrandBySlug(slug: string): Promise<Brand | null> {
  return (await load()).bySlug.get(slug) ?? null;
}

/** Convenience for the top-level redirect on `/`. First enabled brand by
 *  alphabetical label; falls back to "starter-story" if nothing is seeded. */
export async function getDefaultBrandSlug(): Promise<string> {
  const enabled = await getEnabledBrands();
  return enabled[0]?.slug ?? "starter-story";
}

/** Invalidate the request-scoped cache. Call after mutations (create brand,
 *  edit brand settings) to ensure the next read sees the update. Required
 *  because the Map/array above are module-level. */
export function invalidateBrandCache(): void {
  cached = null;
}

/** Single-row lookup that bypasses the cache — use from API route handlers
 *  where freshness matters more than the round trip. */
export async function fetchBrandBySlug(slug: string): Promise<Brand | null> {
  const [row] = await db
    .select()
    .from(brands)
    .where(sql`lower(${brands.slug}) = ${slug.toLowerCase()}`)
    .limit(1);
  return row ?? null;
}
