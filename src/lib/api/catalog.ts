/**
 * Workspace reference data for `/api/v1`: brands, accounts, formats. Small
 * tables, so these return everything matching the filter — no pagination.
 */
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brandStatuses, brands, formats, users } from "@/lib/db/schema";
import { ApiError } from "./http";
import { serializeAccount, serializeBrand, serializeFormat, type ApiAccount, type ApiBrand, type ApiFormat } from "./serialize";

export async function listBrands(opts: { include_disabled?: boolean } = {}): Promise<{ data: ApiBrand[] }> {
  const rows = await db
    .select()
    .from(brands)
    .where(opts.include_disabled ? undefined : eq(brands.disabled, false))
    .orderBy(asc(brands.sortOrder), asc(brands.label));
  return { data: rows.map(serializeBrand) };
}

export async function listAccounts(
  opts: { brand?: string; platform?: string; include_inactive?: boolean } = {},
): Promise<{ data: ApiAccount[] }> {
  const where: SQL[] = [isNull(accounts.deletedAt)];
  if (opts.brand && opts.brand !== "all") where.push(eq(brands.slug, opts.brand));
  if (opts.platform) where.push(eq(accounts.platform, opts.platform));
  if (!opts.include_inactive) where.push(eq(accounts.isActive, true));
  const rows = await db
    .select({ account: accounts, brandSlug: brands.slug })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(...where))
    .orderBy(asc(brands.sortOrder), asc(accounts.platform), asc(accounts.handle));
  return { data: rows.map((r) => serializeAccount(r.account, r.brandSlug)) };
}

export async function listFormats(opts: { brand?: string } = {}): Promise<{ data: ApiFormat[] }> {
  const rows = await db
    .select()
    .from(formats)
    .where(opts.brand && opts.brand !== "all" ? eq(formats.brand, opts.brand) : undefined)
    .orderBy(asc(formats.brand), asc(formats.name));
  return { data: rows.map(serializeFormat) };
}

export interface ApiUser {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "creator";
  avatar_url: string | null;
  /** Brand slugs this person can change. Admins: every brand. */
  edits_brands: string[] | "all";
  is_active: boolean;
  created_at: string;
}

/** Team members — for `editor_id` filters and assignments. */
export async function listUsers(opts: { include_inactive?: boolean } = {}): Promise<{ data: ApiUser[] }> {
  const rows = await db
    .select()
    .from(users)
    .where(opts.include_inactive ? undefined : isNull(users.deactivatedAt))
    .orderBy(asc(users.name), asc(users.email));
  const allBrands = await db.select({ id: brands.id, slug: brands.slug }).from(brands);
  const slugOf = new Map(allBrands.map((b) => [b.id, b.slug]));
  return {
    data: rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      avatar_url: u.avatarUrl,
      edits_brands: u.role === "admin" ? "all" : (u.brandIds ?? []).map((id) => slugOf.get(id)).filter((s): s is string => !!s),
      is_active: !u.deactivatedAt,
      created_at: u.createdAt.toISOString(),
    })),
  };
}

export interface ApiStatus {
  name: string;
  brand: string;
  color: string;
  position: number;
  is_pipeline_column: boolean;
}

/** Workflow statuses per brand, in board order. The `status` filter and PATCH accept these names. */
export async function listStatuses(opts: { brand?: string } = {}): Promise<{ data: ApiStatus[] }> {
  const where: SQL[] = [];
  if (opts.brand && opts.brand !== "all") {
    const [b] = await db.select({ id: brands.id }).from(brands).where(eq(brands.slug, opts.brand)).limit(1);
    if (!b) throw new ApiError("not_found", `No brand with slug "${opts.brand}".`);
    where.push(eq(brandStatuses.brandId, b.id));
  }
  const rows = await db
    .select({ s: brandStatuses, slug: brands.slug })
    .from(brandStatuses)
    .innerJoin(brands, eq(brands.id, brandStatuses.brandId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(brands.sortOrder), asc(brandStatuses.position));
  return {
    data: rows.map((r) => ({
      name: r.s.name,
      brand: r.slug,
      color: r.s.color,
      position: r.s.position,
      is_pipeline_column: r.s.isPipelineColumn,
    })),
  };
}
