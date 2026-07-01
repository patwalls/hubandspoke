import { cache } from "react";
import { db } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { asc, sql } from "drizzle-orm";

export type Brand = typeof brands.$inferSelect;

export type BrandListEntry = Pick<
  Brand,
  "id" | "slug" | "label" | "avatarUrl" | "color" | "disabled"
>;

const BRAND_PRIORITY: Record<string, number> = {
  "starter-story": 0,
  "matg": 1,
  "my-first-million": 2,
  "futurepedia": 3,
  "hubspot-marketing": 4,
  "jonathan-hunt": 5,
};

// React `cache()` is request-scoped: deduped within a render pass, cleared
// between requests. A plain module-level `let` was process-scoped and
// outlived invalidation calls on Next 16's RSC path, causing stale brand
// state after PATCH /api/brands.
const load = cache(async () => {
  const rows = await db.select().from(brands).orderBy(asc(brands.label));
  rows.sort((a, b) => {
    const pa = BRAND_PRIORITY[a.slug] ?? 99;
    const pb = BRAND_PRIORITY[b.slug] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.label.localeCompare(b.label);
  });
  const enabled = rows.filter((b) => !b.disabled);
  const bySlug = new Map(rows.map((b) => [b.slug, b]));
  return { all: rows, enabled, bySlug };
});

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

/** No-op kept for call-site compatibility — `load` is request-scoped via
 *  React `cache()`, so there's nothing to invalidate. */
export function invalidateBrandCache(): void {}

/** Single-row lookup that bypasses any caching — use from API route handlers
 *  where freshness matters more than the round trip. */
export async function fetchBrandBySlug(slug: string): Promise<Brand | null> {
  const [row] = await db
    .select()
    .from(brands)
    .where(sql`lower(${brands.slug}) = ${slug.toLowerCase()}`)
    .limit(1);
  return row ?? null;
}
