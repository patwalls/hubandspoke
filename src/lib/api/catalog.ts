/**
 * Workspace reference data for `/api/v1`: brands, accounts, formats. Small
 * tables, so these return everything matching the filter — no pagination.
 */
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brands, formats } from "@/lib/db/schema";
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
