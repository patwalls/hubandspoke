import { cache } from "react";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, brandStatuses } from "@/lib/db/schema";
import type { StatusColorToken } from "@/lib/badge-colors";

export type BrandStatus = {
  id: string;
  brandId: string;
  name: string;
  color: StatusColorToken;
  position: number;
  isPipelineColumn: boolean;
  isProtected: boolean;
};

export type DefaultStatusSeed = {
  name: string;
  color: StatusColorToken;
  isPipelineColumn?: boolean;
  isProtected?: boolean;
};

// Names of statuses that the app hard-codes elsewhere — renaming any of
// these would silently break a flow. Centralized here so future code stays
// in sync; the backfill script reads the same list to retro-flag rows.
//   - Idea: created by repost/cross-post/duplicate/clip-out/threshold-monitor;
//     filtered by queue-view, cross-post-feed, evergreen-scan
//   - Assigned: target status of triage "accept", clip promotion, queue
//     outcome flow; my-work role logic keys off it
//   - Published: publish-date filters in queries.ts
//   - Killed: kill-confirmation modal in content-detail.tsx
//   - Scheduled: write-only via the publish route's schedule mode; the
//     schedule-reconcile sweep keys off the literal "Scheduled" string to
//     find pending items, and content-detail.tsx filters it out of the
//     editable status dropdown. Renaming it would break the matcher.
export const PROTECTED_STATUS_NAMES: ReadonlySet<string> = new Set([
  "Idea",
  "Assigned",
  "Scheduled",
  "Published",
  "Killed",
]);

// Seeded for every new brand. See PROTECTED_STATUS_NAMES above for why
// certain names are locked from rename/delete in the UI.
export const DEFAULT_BRAND_STATUSES: ReadonlyArray<DefaultStatusSeed> = [
  { name: "Idea", color: "zinc", isProtected: true },
  { name: "Assigned", color: "pink", isPipelineColumn: true, isProtected: true },
  { name: "Review", color: "yellow", isPipelineColumn: true },
  { name: "Ready To Publish", color: "pink", isPipelineColumn: true },
  { name: "On Hold", color: "slate", isPipelineColumn: true },
  { name: "Scheduled", color: "blue", isProtected: true },
  { name: "Published", color: "pink", isProtected: true },
  { name: "Killed", color: "zinc", isProtected: true },
];

// One-time seed for brands that already exist in production. starter-story
// is the live brand and has rows under names beyond the default set, so it
// gets the full legacy palette; every other brand gets the default seed.
export const STARTER_STORY_LEGACY_STATUSES: ReadonlyArray<DefaultStatusSeed> = [
  { name: "Idea", color: "zinc", isProtected: true },
  { name: "To Assign", color: "zinc" },
  { name: "Pre-Production", color: "pink" },
  { name: "Scoping Call", color: "zinc" },
  { name: "Scoping Call Done", color: "blue" },
  { name: "Outreach", color: "emerald" },
  { name: "Yes BUT Later", color: "green" },
  { name: "Scheduled Shoot", color: "zinc" },
  { name: "Searching/Planning", color: "sky" },
  { name: "Assigned", color: "pink", isPipelineColumn: true, isProtected: true },
  { name: "Editing (V1)", color: "amber" },
  { name: "Graphics (V2)", color: "zinc" },
  { name: "Review", color: "yellow", isPipelineColumn: true },
  { name: "Ready To Publish", color: "pink", isPipelineColumn: true },
  { name: "On Hold", color: "slate", isPipelineColumn: true },
  { name: "Published", color: "pink", isProtected: true },
  { name: "Killed", color: "zinc", isProtected: true },
];

// Drizzle's transaction callback receives a tx with the same insert/select
// surface as `db` — we just need that subset. Inferring it from
// `db.transaction` keeps us decoupled from the (gnarly) drizzle generics.
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | DbTx;

export async function insertDefaultStatusesForBrand(
  brandId: string,
  executor: Executor = db,
  seed: ReadonlyArray<DefaultStatusSeed> = DEFAULT_BRAND_STATUSES
): Promise<void> {
  if (seed.length === 0) return;
  await executor.insert(brandStatuses).values(
    seed.map((s, idx) => ({
      brandId,
      name: s.name,
      color: s.color,
      position: idx,
      isPipelineColumn: s.isPipelineColumn ?? false,
      isProtected: s.isProtected ?? false,
    }))
  );
}

const loadAll = cache(async (): Promise<BrandStatus[]> => {
  const rows = await db
    .select({
      id: brandStatuses.id,
      brandId: brandStatuses.brandId,
      name: brandStatuses.name,
      color: brandStatuses.color,
      position: brandStatuses.position,
      isPipelineColumn: brandStatuses.isPipelineColumn,
      isProtected: brandStatuses.isProtected,
    })
    .from(brandStatuses)
    .orderBy(asc(brandStatuses.brandId), asc(brandStatuses.position));
  return rows.map((r) => ({ ...r, color: r.color as StatusColorToken }));
});

const loadBySlug = cache(
  async (brandSlug: string): Promise<BrandStatus[]> => {
    const rows = await db
      .select({
        id: brandStatuses.id,
        brandId: brandStatuses.brandId,
        name: brandStatuses.name,
        color: brandStatuses.color,
        position: brandStatuses.position,
        isPipelineColumn: brandStatuses.isPipelineColumn,
        isProtected: brandStatuses.isProtected,
      })
      .from(brandStatuses)
      .innerJoin(brands, eq(brandStatuses.brandId, brands.id))
      .where(sql`lower(${brands.slug}) = ${brandSlug.toLowerCase()}`)
      .orderBy(asc(brandStatuses.position));
    return rows.map((r) => ({ ...r, color: r.color as StatusColorToken }));
  }
);

export async function getBrandStatuses(
  brandSlug: string
): Promise<BrandStatus[]> {
  return loadBySlug(brandSlug);
}

// Map<status name, color token> for one brand. Used to render badges.
export const getStatusPalette = cache(
  async (brandSlug: string): Promise<Map<string, string>> => {
    const rows = await loadBySlug(brandSlug);
    return new Map(rows.map((r) => [r.name, r.color]));
  }
);

// Map<brandSlug, Map<status name, color token>> for cross-brand surfaces
// (my-work, global search). Loads all rows in one query.
export const getAllStatusPalettes = cache(
  async (): Promise<Map<string, Map<string, string>>> => {
    const rows = await db
      .select({
        slug: brands.slug,
        name: brandStatuses.name,
        color: brandStatuses.color,
      })
      .from(brandStatuses)
      .innerJoin(brands, eq(brandStatuses.brandId, brands.id));
    const palettes = new Map<string, Map<string, string>>();
    for (const r of rows) {
      let p = palettes.get(r.slug);
      if (!p) {
        p = new Map();
        palettes.set(r.slug, p);
      }
      p.set(r.name, r.color);
    }
    return palettes;
  }
);

// Names of statuses where isPipelineColumn = true, in position order. Used
// by queries.ts to compute "in-flight" counts for a brand.
export async function getInFlightStatusNames(
  brandSlug: string
): Promise<string[]> {
  const rows = await loadBySlug(brandSlug);
  return rows.filter((r) => r.isPipelineColumn).map((r) => r.name);
}

// All in-flight names across every brand — used by /all and cross-brand
// pipeline queries that don't have a single brand context.
export async function getAllInFlightStatusNames(): Promise<string[]> {
  const all = await loadAll();
  const set = new Set<string>();
  for (const r of all) if (r.isPipelineColumn) set.add(r.name);
  return Array.from(set);
}
